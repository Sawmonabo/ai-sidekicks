use std::ffi::OsString;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::path::Path;
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::{
    LeftoverSweep, TerminalSignal, create_file_atomically, name_program, read_child_exit,
    send_signal,
};

use super::{COMMAND_PROVIDER_VARIABLE, run_command_wrapper_with};
use crate::ipc::caller_process::system_reader::ProcessTableReader;
use crate::provider::command::channel::{
    CommandChannel, DaemonRequest, PartyRecord, ReceivedRecord,
};
use crate::provider::command::harness_test_name;
use crate::provider::driver::PROVIDERS;

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
        run_command_wrapper_with(&process_arguments, &own),
        ExitCode::SUCCESS
    );
}

/// A script standing in for the wrapper's link inside a command's terminal: it starts this binary
/// as a wrapper over the arguments the terminal gives it.
fn write_stand_in(folder: &Path) -> std::path::PathBuf {
    let path = folder.join("sidekicks-command-wrapper");
    let program = std::env::current_exe().expect("the test program");
    let script = format!(
        "#!/bin/sh\n{WRAPPER_ARGUMENTS_VARIABLE}=$(printf '%s\\037' \"$@\")\nexport \
         {WRAPPER_ARGUMENTS_VARIABLE}\nexec '{}' {}\n",
        program.display(),
        harness_arguments().join(" "),
    );
    create_file_atomically(&path, script.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the stand-in is written");
    path
}

/// A channel this test answers as the daemon, for wrappers it starts.
fn open_channel(folder: &Path) -> CommandChannel {
    CommandChannel::open(
        folder.join("channel"),
        std::process::id(),
        Arc::new(ProcessTableReader::for_this_program().expect("a reader")) as _,
    )
    .expect("the channel opens")
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
/// named `/bin/sh`.
fn line_wrapper(line: &str) -> Command {
    let mut command = wrapper(&[line], None);
    command
        .env(COMMAND_PROVIDER_VARIABLE, prefixing_provider())
        .env("SHELL", "/bin/sh");
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
    let stand_in = write_stand_in(folder.path());
    let relayed = |command: &'static str| {
        [
            "--conversation",
            "conversation",
            "--process",
            "process-1",
            "--tty",
            "--",
            "/bin/sh",
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
    let party = loop {
        let records = next_records(&channel, &mut watch).await;
        if let Some(starting) = records
            .iter()
            .find(|received| matches!(received.record, PartyRecord::Starting { .. }))
        {
            break starting.party;
        }
    };
    let _output = read_until(&mut child, "ready");
    send_signal(child.id(), TerminalSignal::Hangup).expect("the hangup is sent");
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
            next_records(&channel, &mut watch)
                .await
                .into_iter()
                .map(|received| received.record)
                .filter(|record| {
                    matches!(record, PartyRecord::Stopped {} | PartyRecord::Exited { .. })
                }),
        );
    }
    assert_eq!(told.first(), Some(&PartyRecord::Stopped {}));
    assert_eq!(ended_by(&mut child).as_deref(), Some("SIGKILL"));
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
// Run on Linux, in the container leg.
#[cfg(target_os = "linux")]
#[test]
fn a_hook_line_starts_with_no_subreaper_set() {
    let reader = "python3 -c 'import ctypes; libc = ctypes.CDLL(None); value = ctypes.c_int(); \
                  libc.prctl(37, ctypes.byref(value)); print(value.value)'";
    let (is_success, output, errors) = run_to_end(line_wrapper(reader));
    assert!(is_success, "{errors}");
    assert!(output.lines().any(|line| line == "0"), "{output}");
}

// Fails when an agent's line runs under `/bin/sh` where the provider named bash, which on Linux is
// dash and knows no `builtin`. Mutation: run every line with `FALLBACK_SHELL`. Run on Linux, in
// the container leg.
#[cfg(target_os = "linux")]
#[test]
fn an_agent_line_runs_with_the_shell_the_provider_named() {
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
