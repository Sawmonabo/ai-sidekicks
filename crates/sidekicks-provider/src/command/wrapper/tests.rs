use std::ffi::OsString;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitCode, Stdio};
use std::sync::Arc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::{
    CAN_TAKE_IN_ORPHANS, DOES_POSIX_SHELL_LACK_BUILTIN, DOES_TERMINAL_OUTLIVE_ITS_LEADER,
    LeftoverSweep, POSIX_SHELL, TerminalSignal, create_file_atomically, harness_test_name,
    name_program, pin_running_process, read_child_exit, send_signal, wait_for_exit,
};

use super::{COMMAND_PROVIDER_VARIABLE, run_command_wrapper_with};
use crate::command::channel::{
    CommandChannel, DaemonRequest, PartyId, PartyRecord, ReceivedRecord,
};
use crate::driver::PROVIDERS;

/// A command that prints `ready` and then a line every 50 ms until it is stopped.
const TICKING_COMMAND: &str = "echo ready; while :; do echo tick; sleep 0.05; done";

/// A command that prints `ready` and then stops itself, as a job control stop does.
const SELF_STOPPING_COMMAND: &str = "echo ready; kill -STOP $$; sleep 30";

/// The variable a started wrapper reads its own arguments from, joined by the unit separator.
const WRAPPER_ARGUMENTS_VARIABLE: &str = "SIDEKICKS_TEST_WRAPPER_ARGUMENTS";

/// The test the started wrapper runs as.
const WRAPPER_PROCESS_TEST: &str = "a_wrapper_process_runs_its_arguments";

/// The harness arguments that run this binary as a wrapper.
fn harness_arguments() -> [String; 5] {
    [
        "--exact".to_owned(),
        harness_test_name(module_path!(), WRAPPER_PROCESS_TEST),
        "--ignored".to_owned(),
        "--nocapture".to_owned(),
        "--quiet".to_owned(),
    ]
}

/// This test binary started as a wrapper over `own`, under the name `name` where it is given, its
/// standard streams piped.
fn wrapper(own: &[&str], name: Option<&Path>) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("the test program"));
    if let Some(name) = name {
        name_program(&mut command, name.as_os_str()).expect("the name is set");
    }
    command
        .args(harness_arguments())
        .env(WRAPPER_ARGUMENTS_VARIABLE, own.join("\u{1f}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
#[ignore = "run only as the wrapper process another test starts"]
fn a_wrapper_process_runs_its_arguments() {
    let process_arguments: Vec<OsString> = std::env::args_os().collect();
    let own: Vec<OsString> = std::env::var(WRAPPER_ARGUMENTS_VARIABLE)
        .expect("the wrapper's arguments")
        .split('\u{1f}')
        .filter(|argument| !argument.is_empty())
        .map(OsString::from)
        .collect();
    assert_eq!(
        run_command_wrapper_with(&process_arguments, &own, stand_in_program),
        ExitCode::SUCCESS
    );
}

/// The program a wrapper process restarts as for its inner form: the stand-in it was started as,
/// since this binary itself would read the inner form's arguments as the harness's.
fn stand_in_program() -> std::io::Result<PathBuf> {
    std::env::args_os()
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("the wrapper process has no name"))
}

/// A script standing in for the wrapper's link inside a command's terminal: it starts this binary
/// as a wrapper over the arguments the terminal gives it, with the harness's own output and the
/// command's sent to `/dev/null` where `is_output_dropped`, so only what the command writes to
/// `/dev/tty` reaches the terminal.
fn write_stand_in(folder: &Path, is_output_dropped: bool) -> std::path::PathBuf {
    let path = folder.join("sidekicks-command-wrapper");
    let program = std::env::current_exe().expect("the test program");
    let script = format!(
        "#!/bin/sh\n{WRAPPER_ARGUMENTS_VARIABLE}=$(printf '%s\\037' \"$@\")\nexport \
         {WRAPPER_ARGUMENTS_VARIABLE}\nexec '{}' {}{}\n",
        program.display(),
        harness_arguments().join(" "),
        if is_output_dropped {
            " >/dev/null 2>&1"
        } else {
            ""
        },
    );
    create_file_atomically(&path, script.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the stand-in is written");
    path
}

/// A channel this test answers as the daemon, for wrappers it starts, bound to this test's process,
/// the provider's place here.
fn open_channel(folder: &Path) -> CommandChannel {
    let channel = CommandChannel::open(
        folder.join("channel"),
        Arc::new(ProcessTableReader::for_this_program().expect("a reader")) as _,
    )
    .expect("the channel opens");
    channel.bind(std::process::id());
    channel
}

/// The id of a provider that runs its commands through a shell prefix, from the providers' table.
fn prefixing_provider() -> &'static str {
    PROVIDERS
        .iter()
        .find(|descriptor| descriptor.shell_prefix_command.is_some())
        .expect("a provider prefixes its commands")
        .id
}

/// This binary started as a wrapper over the one `line` that provider hands it, its line's shell
/// named the POSIX shell.
fn line_wrapper(line: &str) -> Command {
    let mut command = wrapper(&[line], None);
    command
        .env(COMMAND_PROVIDER_VARIABLE, prefixing_provider())
        .env("SHELL", POSIX_SHELL);
    command
}

/// An agent's Bash line running `command` as the provider writes it, its working folder kept in
/// `folder`.
fn bash_line(command: &str, folder: &Path) -> String {
    format!(
        "eval '{}' < /dev/null && pwd -P >| {}",
        command.replace('\'', r#"'"'"'"#),
        folder.join("cwd").display()
    )
}

/// Runs `command` to its end, answering its exit's success, its output and its errors.
fn run_to_end(mut command: Command) -> (bool, String, String) {
    let output = command.output().expect("the wrapper runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn with_channel(command: &mut Command, channel: &CommandChannel) {
    for (name, value) in channel.environment() {
        command.env(name, value);
    }
}

/// Waits for the next records, failing the test after a while.
async fn next_records(
    channel: &CommandChannel,
    watch: &mut sidekicks_platforms::FolderArrivalWatch,
) -> Vec<ReceivedRecord> {
    tokio::time::timeout(Duration::from_secs(20), channel.next_records(watch))
        .await
        .expect("a record comes")
        .expect("the records read")
}

/// Reads the child's output until a line holding `marker`.
fn read_until(child: &mut Child, marker: &str) -> BufReader<std::process::ChildStdout> {
    let mut lines = BufReader::new(child.stdout.take().expect("its output"));
    let mut line = String::new();
    while !line.contains(marker) {
        line.clear();
        if lines.read_line(&mut line).expect("it prints") == 0 {
            let mut errors = String::new();
            child
                .stderr
                .take()
                .expect("its errors")
                .read_to_string(&mut errors)
                .expect("they read");
            panic!("the wrapper ended before {marker:?}: {errors}");
        }
    }
    lines
}

fn ended_by(child: &mut Child) -> Option<String> {
    read_child_exit(&child.wait().expect("the wrapper ends"), None).signal_name
}

/// Types Ctrl+Z into a terminal command whose lines `output` reads and fails, killing the wrapper
/// `child` first, unless its lines stop within 3 s, a 500 ms quiet standing for the stop.
fn type_ctrl_z_until_quiet(
    child: &mut Child,
    input: &mut ChildStdin,
    output: BufReader<ChildStdout>,
) {
    // The lines are read on a thread of their own, so a quiet shows as no line in time.
    let (line_sent, line_came) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in output.lines() {
            if line_sent.send(line).is_err() {
                return;
            }
        }
    });
    let typed_at = Instant::now();
    input.write_all(b"\x1a").expect("ctrl+z is typed");
    input.flush().expect("it is sent");
    loop {
        match line_came.recv_timeout(Duration::from_millis(500)) {
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => panic!("the output ended"),
            Ok(_) if typed_at.elapsed() >= Duration::from_secs(3) => {
                child.kill().expect("the wrapper is killed");
                panic!("the typed ctrl+z left the command running");
            }
            Ok(_) => {}
        }
    }
}

/// The party whose `Starting` comes next on `channel`.
async fn starting_party(
    channel: &CommandChannel,
    watch: &mut sidekicks_platforms::FolderArrivalWatch,
) -> PartyId {
    loop {
        let records = next_records(channel, watch).await;
        if let Some(starting) = records
            .iter()
            .find(|received| matches!(received.record, PartyRecord::Starting { .. }))
        {
            return starting.party;
        }
    }
}

/// Sends `party` the daemon's stop and fails unless its `Stopped` comes before its `Exited`.
async fn stop_in_order(
    channel: &CommandChannel,
    watch: &mut sidekicks_platforms::FolderArrivalWatch,
    party: PartyId,
) {
    channel
        .send_request(party, &DaemonRequest::Stop {})
        .await
        .expect("the stop is sent");
    let mut told = Vec::new();
    while !told
        .iter()
        .any(|record| matches!(record, PartyRecord::Exited { .. }))
    {
        told.extend(
            next_records(channel, watch)
                .await
                .into_iter()
                .map(|received| received.record)
                .filter(|record| {
                    matches!(record, PartyRecord::Stopped {} | PartyRecord::Exited { .. })
                }),
        );
    }
    assert_eq!(told.first(), Some(&PartyRecord::Stopped {}));
}

// Fails when a line that is no agent's command writes a record or waits for `go`, when an agent's
// Bash line is not told to the daemon, or when the command runs with `SIGPIPE` ignored, which
// makes `yes` report a broken pipe.
#[tokio::test]
async fn a_hook_line_runs_unchanged_and_a_bash_line_waits_for_go_both_with_sigpipe_back() {
    let folder = tempfile::tempdir().expect("a folder");
    let channel = open_channel(folder.path());
    let mut watch = channel.watch().await.expect("the channel is watched");
    let bash_line = bash_line("yes | head -1", folder.path());
    for (line, is_agent_command) in [("yes | head -1", false), (bash_line.as_str(), true)] {
        let mut command = line_wrapper(line);
        with_channel(&mut command, &channel);
        let mut child = command.spawn().expect("the wrapper starts");
        if is_agent_command {
            let records = next_records(&channel, &mut watch).await;
            let starting = records
                .iter()
                .find(|received| matches!(received.record, PartyRecord::Starting { .. }))
                .expect("the command is told");
            assert!(matches!(
                &starting.record,
                PartyRecord::Starting { command, .. } if command == "yes | head -1"
            ));
            channel
                .send_request(starting.party, &DaemonRequest::Go {})
                .await
                .expect("go is sent");
        }
        let mut output = String::new();
        child
            .stdout
            .take()
            .expect("its output")
            .read_to_string(&mut output)
            .expect("it prints");
        let mut errors = String::new();
        child
            .stderr
            .take()
            .expect("its errors")
            .read_to_string(&mut errors)
            .expect("it reads");
        assert!(child.wait().expect("it ends").success(), "{line}: {errors}");
        assert!(
            output.lines().any(|printed| printed == "y"),
            "{line}: {output}"
        );
        assert!(!errors.contains("Broken pipe"), "{line}: {errors}");
        if !is_agent_command {
            let records =
                tokio::time::timeout(Duration::from_millis(300), channel.next_records(&mut watch));
            assert!(records.await.is_err(), "a hook line wrote a record");
        }
    }
}

// Fails when the wrapper passes no stop signal into its command's terminal, or when the daemon's
// stop does not kill the terminal's whole session.
#[tokio::test]
async fn a_terminal_command_takes_ctrl_c_the_interrupt_and_a_stop_past_an_ignored_hangup() {
    let folder = tempfile::tempdir().expect("a folder");
    let stand_in = write_stand_in(folder.path(), false);
    let relayed = |command: &'static str| {
        [
            "--conversation",
            "conversation",
            "--process",
            "process-1",
            "--tty",
            "--",
            POSIX_SHELL,
            "-c",
            command,
        ]
    };

    // Ctrl+C typed into the provider's terminal reaches the command as its terminal's interrupt.
    let mut child = wrapper(&relayed("echo ready; exec sleep 30"), Some(&stand_in))
        .spawn()
        .expect("the wrapper starts");
    let _output = read_until(&mut child, "ready");
    let mut input = child.stdin.take().expect("its input");
    input.write_all(b"\x03").expect("ctrl+c is typed");
    input.flush().expect("it is sent");
    assert_eq!(ended_by(&mut child).as_deref(), Some("SIGINT"));

    // The relay's interrupt, the signal it sends the wrapper, reaches the command too.
    let mut child = wrapper(&relayed("echo ready; exec sleep 30"), Some(&stand_in))
        .spawn()
        .expect("the wrapper starts");
    let _output = read_until(&mut child, "ready");
    send_signal(child.id(), TerminalSignal::Interrupt).expect("the interrupt is sent");
    assert_eq!(ended_by(&mut child).as_deref(), Some("SIGINT"));

    // The daemon's stop ends a command that ignores its hangup and every stop signal.
    let channel = open_channel(folder.path());
    let mut watch = channel.watch().await.expect("the channel is watched");
    let mut command = wrapper(
        &relayed("trap '' HUP INT TERM; echo ready; while :; do sleep 1; done"),
        Some(&stand_in),
    );
    with_channel(&mut command, &channel);
    let mut child = command.spawn().expect("the wrapper starts");
    let party = starting_party(&channel, &mut watch).await;
    let _output = read_until(&mut child, "ready");
    send_signal(child.id(), TerminalSignal::Hangup).expect("the hangup is sent");
    stop_in_order(&channel, &mut watch, party).await;
    assert_eq!(ended_by(&mut child).as_deref(), Some("SIGKILL"));
}

// Fails when a relayed command outside a terminal is not run and stopped as its own process group:
// a forwarded interrupt taken twice or not at all, a stop that leaves its background process
// running, or `Stopped` told after `Exited`. Mutations: `signal_command_group` signaling the
// child's pid in place of its group; the stop follower letting go of the state's lock before it
// kills.
#[tokio::test]
async fn a_relayed_command_takes_one_interrupt_and_a_stop_ends_its_whole_group() {
    let folder = tempfile::tempdir().expect("a folder");
    let channel = open_channel(folder.path());
    let mut watch = channel.watch().await.expect("the channel is watched");
    let mut command = wrapper(
        &[
            "--conversation",
            "conversation",
            "--process",
            "process-1",
            "--",
            POSIX_SHELL,
            "-c",
            "trap 'echo interrupted' INT; sleep 30 & echo \"background $!\"; echo ready; \
             while :; do wait; done",
        ],
        None,
    );
    with_channel(&mut command, &channel);
    let mut child = command.spawn().expect("the wrapper starts");
    let party = starting_party(&channel, &mut watch).await;
    let mut lines = BufReader::new(child.stdout.take().expect("its output")).lines();
    let mut background = None;
    let mut next_line = || {
        lines
            .next()
            .expect("the command prints")
            .expect("a line reads")
    };
    loop {
        let line = next_line();
        if let Some(id) = line.strip_prefix("background ") {
            background = Some(id.parse::<u32>().expect("a process id"));
        }
        if line == "ready" {
            break;
        }
    }
    let background = background.expect("the background process is named");
    send_signal(child.id(), TerminalSignal::Interrupt).expect("the interrupt is sent");
    while next_line() != "interrupted" {}
    stop_in_order(&channel, &mut watch, party).await;
    assert_eq!(ended_by(&mut child).as_deref(), Some("SIGKILL"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while pin_running_process(background)
            .expect("the process reads")
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the stop ends the background process");
    // The output ends once the background process, which holds it open, has ended.
    let rest: Vec<String> = lines.map(|line| line.expect("a line reads")).collect();
    assert!(!rest.iter().any(|line| line == "interrupted"), "{rest:?}");
}

// Fails, outside a terminal, when a command that stopped itself reads as ended: its stop signals
// are then dropped and the daemon's stop does nothing, so the wrapper waits on it for good. It
// stops right after its `ready`, while the daemon's stop still crosses the channel's folder.
// Mutation: the platforms crate's `wait_for_exit` with no bound as one blocking `waitid`.
// Fails, in a terminal of its own, when a typed Ctrl+Z does not stop the command, so its lines
// keep coming; the daemon's stop then proves it ends a stopped job. Mutation: the `Inner` arm
// executing the command in its own place again.
#[tokio::test]
async fn a_stopped_command_still_takes_the_daemon_s_stop() {
    let folder = tempfile::tempdir().expect("a folder");
    let stand_in = write_stand_in(folder.path(), false);
    let channel = open_channel(folder.path());
    let mut watch = channel.watch().await.expect("the channel is watched");
    for is_tty in [false, true] {
        let mut own = vec!["--conversation", "conversation", "--process", "process-1"];
        if is_tty {
            own.extend(["--tty", "--", POSIX_SHELL, "-c", TICKING_COMMAND]);
        } else {
            own.extend(["--", POSIX_SHELL, "-c", SELF_STOPPING_COMMAND]);
        }
        let mut command = wrapper(&own, is_tty.then_some(stand_in.as_path()));
        with_channel(&mut command, &channel);
        let mut child = command.spawn().expect("the wrapper starts");
        let party = starting_party(&channel, &mut watch).await;
        let output = read_until(&mut child, "ready");
        // The input stays open until the wrapper ended, as a provider's terminal does.
        let mut input = child.stdin.take().expect("its input");
        if is_tty {
            type_ctrl_z_until_quiet(&mut child, &mut input, output);
        }
        stop_in_order(&channel, &mut watch, party).await;
        assert_eq!(
            ended_by(&mut child).as_deref(),
            Some("SIGKILL"),
            "with a terminal: {is_tty}"
        );
    }
}

// Fails when a hangup the wrapper passes on never reaches a stopped command, one a typed Ctrl+Z
// stopped in a terminal or one that stopped itself outside one, which holds every signal but a
// kill until it is continued, so the wrapper and its stopped command are left for good. Mutation:
// the `SIGCONT` dropped after a passed-on hangup or terminate on either path.
#[test]
fn a_passed_on_hangup_ends_a_stopped_command() {
    let folder = tempfile::tempdir().expect("a folder");
    let stand_in = write_stand_in(folder.path(), false);
    for is_tty in [false, true] {
        let mut own = vec!["--conversation", "conversation", "--process", "process-1"];
        if is_tty {
            own.extend(["--tty", "--", POSIX_SHELL, "-c", TICKING_COMMAND]);
        } else {
            own.extend(["--", POSIX_SHELL, "-c", SELF_STOPPING_COMMAND]);
        }
        let mut child = wrapper(&own, is_tty.then_some(stand_in.as_path()))
            .spawn()
            .expect("the wrapper starts");
        let output = read_until(&mut child, "ready");
        // The input stays open until the wrapper ended, as a provider's terminal does.
        let mut input = child.stdin.take().expect("its input");
        if is_tty {
            type_ctrl_z_until_quiet(&mut child, &mut input, output);
        }
        send_signal(child.id(), TerminalSignal::Hangup).expect("the hangup is sent");
        // Past the job's end the wrapper drains its output for up to 2 s.
        if !wait_for_exit(child.id(), Some(Duration::from_secs(10)))
            .expect("the wrapper is watched")
        {
            child.kill().expect("the wrapper is killed");
            panic!("the hangup left the stopped command and its wrapper running: tty {is_tty}");
        }
        assert_eq!(
            ended_by(&mut child).as_deref(),
            Some("SIGHUP"),
            "with a terminal: {is_tty}"
        );
    }
}

// Fails when a terminal command's last output is cut off because the copier ends at the command's
// exit while it still writes to a slow provider terminal and the master still holds bytes.
// Mutation: in `copy_output`, end once the command exited without waiting for the master's quiet.
#[test]
fn a_terminal_command_s_last_output_all_reaches_a_slow_provider_terminal() {
    const OUTPUT_BYTES: usize = 1024 * 1024;
    let folder = tempfile::tempdir().expect("a folder");
    let stand_in = write_stand_in(folder.path(), false);
    let mut child = wrapper(
        &[
            "--conversation",
            "conversation",
            "--process",
            "process-1",
            "--tty",
            "--",
            POSIX_SHELL,
            "-c",
            &format!("head -c {OUTPUT_BYTES} /dev/zero | tr '\\0' z"),
        ],
        Some(&stand_in),
    )
    .spawn()
    .expect("the wrapper starts");
    let mut output = child.stdout.take().expect("its output");
    // The provider's terminal reads late, then slowly, so the copier waits on each write.
    std::thread::sleep(Duration::from_millis(50));
    let mut copied = 0;
    let mut piece = [0_u8; 16 * 1024];
    loop {
        let count = output.read(&mut piece).expect("the output reads");
        if count == 0 {
            break;
        }
        copied += memchr::memchr_iter(b'z', &piece[..count]).count();
        std::thread::sleep(Duration::from_millis(15));
    }
    assert!(child.wait().expect("the wrapper ends").success());
    assert_eq!(copied, OUTPUT_BYTES);
}

// Fails when a terminal command's exit leaves the output copier blocked while a background
// process that ignores its hangup holds the terminal open, so the wrapper waits out the drain's
// cap: Linux sends no hangup to a terminal at its leader's exit, where macOS revokes it. Mutation:
// drop the wake at the command's exit. The harness inside writes nothing to the terminal, so no
// late output of its own can keep the copier reading past the exit.
#[test]
fn a_terminal_command_s_exit_wakes_the_output_copier_past_a_background_holder() {
    // A terminal its leader's exit revokes ends the holder's hold itself.
    if !DOES_TERMINAL_OUTLIVE_ITS_LEADER {
        return;
    }
    let folder = tempfile::tempdir().expect("a folder");
    let stand_in = write_stand_in(folder.path(), true);
    // A shell without job control gives a background command `/dev/null` for its input, so the
    // holder opens the terminal itself.
    let mut child = wrapper(
        &[
            "--conversation",
            "conversation",
            "--process",
            "process-1",
            "--tty",
            "--",
            POSIX_SHELL,
            "-c",
            "(trap '' HUP; exec sleep 5) </dev/tty & echo \"done $!\" >/dev/tty",
        ],
        Some(&stand_in),
    )
    .spawn()
    .expect("the wrapper starts");
    let mut lines = BufReader::new(child.stdout.take().expect("its output")).lines();
    let holder = loop {
        let line = lines
            .next()
            .expect("the command prints")
            .expect("a line reads");
        if let Some(id) = line.trim_end().strip_prefix("done ") {
            break id.parse::<u32>().expect("a process id");
        }
    };
    // Pinned at once, so its stop below reaches no process given its id later.
    let holder = pin_running_process(holder)
        .expect("the holder reads")
        .expect("the holder runs");
    let done_at = Instant::now();
    let status = child.wait().expect("the wrapper ends");
    let waited = done_at.elapsed();
    // Stopped before the checks, so no failure leaves it running.
    holder.stop(Duration::ZERO).expect("the holder is stopped");
    assert!(status.success());
    assert!(
        waited < Duration::from_secs(1),
        "the wrapper took {waited:?}"
    );
}

// Fails when a channel the wrapper cannot join leaves its command running uncovered with nothing
// said, as the wrapper keeps no log. Mutation: drop the standard-error line in `join_channel`.
#[test]
fn a_channel_the_wrapper_cannot_join_says_its_command_runs_uncovered() {
    let folder = tempfile::tempdir().expect("a folder");
    let mut command = line_wrapper(&bash_line("echo ran", folder.path()));
    command
        .env("SIDEKICKS_COMMAND_CHANNEL", folder.path())
        .env("SIDEKICKS_COMMAND_CHANNEL_KEY", "not a key");
    let (is_success, output, errors) = run_to_end(command);
    assert!(is_success, "{errors}");
    assert!(output.lines().any(|line| line == "ran"), "{output}");
    assert!(errors.contains("runs uncovered"), "{errors}");
}

// Fails when a line that is no agent's command starts as the orphans' subreaper, which its
// program then stays across the exec. Mutation: call `take_in_orphans` before the form is read.
#[test]
fn a_hook_line_starts_with_no_subreaper_set() {
    // A system with no child subreaper has none to leave set.
    if !CAN_TAKE_IN_ORPHANS {
        return;
    }
    let reader = "python3 -c 'import ctypes; libc = ctypes.CDLL(None); value = ctypes.c_int(); \
                  libc.prctl(37, ctypes.byref(value)); print(value.value)'";
    let (is_success, output, errors) = run_to_end(line_wrapper(reader));
    assert!(is_success, "{errors}");
    assert!(output.lines().any(|line| line == "0"), "{output}");
}

// Fails when an agent's line runs under `/bin/sh` where the provider named bash, which on Linux is
// dash and knows no `builtin`. Mutation: run every line with `POSIX_SHELL`.
#[test]
fn an_agent_line_runs_with_the_shell_the_provider_named() {
    // A `/bin/sh` that knows `builtin` runs the line as bash would.
    if !DOES_POSIX_SHELL_LACK_BUILTIN {
        return;
    }
    let folder = tempfile::tempdir().expect("a folder");
    let line = format!(
        "{{ \\builtin test -n \"${{X-}}\" && \\builtin export Y=\"$X\"; }} && {}",
        bash_line("echo $Y", folder.path())
    );
    let mut command = line_wrapper(&line);
    command.env("SHELL", "/bin/bash").env("X", "carried");
    let (is_success, output, errors) = run_to_end(command);
    assert!(is_success, "{errors}");
    assert!(output.lines().any(|line| line == "carried"), "{output}");
}
