//! The `sidekicks-command-wrapper` mode a provider runs every shell command through. A line that is
//! no agent's command (a hook, a status line, a tool server's start) is run at once as
//! `/bin/sh -c <line>` and nothing else. An agent's command is told to the daemon over the
//! conversation's channel, started in a process group of its own (an agent's line by the shell the
//! provider wrote it for), its stop signals passed on to that group and its end told and taken as
//! the wrapper's own; one the provider starts with a terminal runs in a terminal the wrapper opens,
//! whose master the wrapper holds, so it copies bytes both ways and reports what the master shows.
//! The wrapper runs no runtime and keeps no log: blocking reads and writes, one signal thread and a
//! thread per copy; what it could not do goes to the daemon as a record, and on standard error
//! where it changes how the command runs.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Once, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::WindowSize;
use sidekicks_platforms::{
    InnerTerminal, RawStandardInput, TerminalSignal, blocking_terminal_master, end_as_child_ended,
    end_by_stop_signal, end_terminal_session, exec_command, name_program, pass_on_stop_signals,
    read_child_exit, read_descriptor_path, read_standard_input_window_size, read_terminal_master,
    signal_command_group, signal_foreground_group, start_in_own_group, start_inner_terminal,
    stop_signal_number, take_in_orphans, terminal_options, wait_for_terminal_command,
};

use crate::provider::command::channel::party::{
    ChannelParty, PartyRecords, PartyRequests, PartyStart, own_arguments,
};
use crate::provider::command::channel::{DaemonRequest, PARTY_SECRET_VARIABLE, PartyRecord};
use crate::provider::command::waiting_checks::cheap_check_delay;
use crate::provider::driver::shell_prefix_command_of;
use crate::standard_error::write_error_line;

/// The name of the link a provider runs every shell command through, which reaches this mode.
pub(crate) const COMMAND_WRAPPER_PROGRAM_NAME: &str = "sidekicks-command-wrapper";

/// The variable naming the provider whose shell prefix the wrapper serves, so it reads that
/// provider's line shape.
pub(crate) const COMMAND_PROVIDER_VARIABLE: &str = "SIDEKICKS_COMMAND_PROVIDER";

/// How long the wrapper waits for the daemon's `go` before it runs the command uncovered.
const GO_WAIT: Duration = Duration::from_secs(10);

/// The shell a line runs with where no other is named: a hook's, and an agent's line whose
/// provider named no usable shell.
const FALLBACK_SHELL: &str = "/bin/sh";

/// The variables the wrapper and its terminal add, which the command never sees: the party's
/// secret descriptor, and the two `alacritty_terminal` sets on the program it starts.
const OWN_VARIABLES: [&str; 3] = [PARTY_SECRET_VARIABLE, "ALACRITTY_WINDOW_ID", "WINDOWID"];

/// The flags the relay writes ahead of a relayed command's own words, and the inner mode's flag.
const CONVERSATION_FLAG: &str = "--conversation";
const PROCESS_FLAG: &str = "--process";
const ARG0_FLAG: &str = "--arg0";
const TTY_FLAG: &str = "--tty";
const INNER_FLAG: &str = "--inner";
const WORDS_SEPARATOR: &str = "--";

/// The window a command's terminal opens at when the wrapper's own standard input is no terminal.
const FALLBACK_WINDOW: WindowSize = WindowSize {
    num_lines: 24,
    num_cols: 80,
    cell_width: 0,
    cell_height: 0,
};

/// How many of the command's last output bytes the wrapper keeps for its last line.
const OUTPUT_TAIL_BYTES: usize = 1024;

/// How long the terminal's output stays quiet, once its command exited, before the wrapper stops
/// waiting for the rest: 10 ms, the quiet `script` drains to once its child is gone.
const OUTPUT_QUIET: Duration = Duration::from_millis(10);

/// The longest the wrapper drains a terminal whose output keeps coming after its command exited:
/// 2 s, the drain cap Codex's exec uses for a grandchild holding its output open.
const OUTPUT_DRAIN_CAP: Duration = Duration::from_secs(2);

/// The party's records, shared by the threads that write them; `None` where the command runs
/// uncovered.
type SharedRecords = Arc<Mutex<Option<PartyRecords>>>;

/// The forms the wrapper is started in.
#[derive(Debug, PartialEq, Eq)]
enum WrapperForm {
    /// A provider's shell prefix: one line, which a shell runs.
    Line(OsString),
    /// The relay's rewrite of a command's start: the command's own words, the name it runs under,
    /// the provider's handle on its process and whether it runs in a terminal.
    Relayed {
        process: String,
        arg0: Option<OsString>,
        is_tty: bool,
        words: Vec<OsString>,
    },
    /// The wrapper started again inside the command's terminal, which runs the words in its place.
    Inner {
        arg0: Option<OsString>,
        words: Vec<OsString>,
    },
}

/// Reads the wrapper's form from its own arguments; `None` for any other arguments.
fn read_form(arguments: &[OsString]) -> Option<WrapperForm> {
    let first = arguments.first()?;
    if first == CONVERSATION_FLAG || first == INNER_FLAG {
        let is_inner = first == INNER_FLAG;
        let mut process = None;
        let mut arg0 = None;
        let mut is_tty = false;
        let mut rest = arguments.iter().skip(1);
        if !is_inner {
            // The conversation's folder, which the relay names for a reader of the arguments.
            rest.next()?;
        }
        loop {
            let flag = rest.next()?;
            if flag == WORDS_SEPARATOR {
                break;
            }
            if flag == ARG0_FLAG {
                arg0 = Some(rest.next()?.clone());
            } else if flag == TTY_FLAG && !is_inner {
                is_tty = true;
            } else if flag == PROCESS_FLAG && !is_inner {
                process = Some(rest.next()?.to_str()?.to_owned());
            } else {
                return None;
            }
        }
        let words: Vec<OsString> = rest.cloned().collect();
        words.first()?;
        return Some(if is_inner {
            WrapperForm::Inner { arg0, words }
        } else {
            WrapperForm::Relayed {
                process: process?,
                arg0,
                is_tty,
                words,
            }
        });
    }
    match arguments {
        [line] => Some(WrapperForm::Line(line.clone())),
        _ => None,
    }
}

/// Runs the wrapper with this process's own arguments, answering the exit code its command ended
/// with.
pub(crate) fn run_command_wrapper() -> ExitCode {
    let process_arguments: Vec<OsString> = std::env::args_os().collect();
    run_command_wrapper_with(&process_arguments, own_arguments(&process_arguments))
}

/// Runs the wrapper over `own_arguments`, the arguments its form is read from, restarting through
/// `process_arguments`, all of this process's own; answers the exit code the command ended with,
/// `64` for arguments of no form and `126` for a command that could not start.
pub(crate) fn run_command_wrapper_with(
    process_arguments: &[OsString],
    own_arguments: &[OsString],
) -> ExitCode {
    let Some(form) = read_form(own_arguments) else {
        write_error_line(
            "sidekicks-command-wrapper takes one line, or the relay's flags and words",
        );
        return ExitCode::from(64);
    };
    match form {
        WrapperForm::Line(line) => {
            let agent_command = std::env::var(COMMAND_PROVIDER_VARIABLE)
                .ok()
                .and_then(|provider| shell_prefix_command_of(&provider))
                .zip(line.to_str())
                .and_then(|(prefix, line)| {
                    (prefix.read_agent_command)(line)
                        .map(|command| (prefix.shell_variable, command))
                });
            match agent_command {
                None => exec_failed(&exec_command(&mut shell_line(
                    Path::new(FALLBACK_SHELL),
                    &line,
                ))),
                Some((shell_variable, command)) => {
                    let shell = named_shell(shell_variable);
                    run_line_command(process_arguments, &shell, &line, command)
                }
            }
        }
        WrapperForm::Relayed {
            process,
            arg0,
            is_tty,
            words,
        } => run_relayed_command(process_arguments, &process, arg0.as_deref(), is_tty, &words),
        WrapperForm::Inner { arg0, words } => {
            exec_failed(&exec_command(&mut word_command(arg0.as_deref(), &words)))
        }
    }
}

/// The shell `variable` names by its absolute path, which the provider wrote an agent's line for;
/// `/bin/sh`, said on standard error, where it names none.
fn named_shell(variable: &str) -> PathBuf {
    match std::env::var_os(variable).map(PathBuf::from) {
        Some(shell) if shell.is_absolute() && shell.is_file() => shell,
        named => {
            let named =
                named.map_or_else(|| "nothing".to_owned(), |named| named.display().to_string());
            write_error_line(&format!(
                "sidekicks-command-wrapper runs the command with {FALLBACK_SHELL}, since {variable} \
                 names {named}, no shell's absolute path"
            ));
            PathBuf::from(FALLBACK_SHELL)
        }
    }
}

/// `<shell> -c <line>`, run under the shell's file name, without the wrapper's own variables.
fn shell_line(shell: &Path, line: &OsStr) -> Command {
    let mut command = Command::new(shell);
    if let Some(name) = shell.file_name()
        && let Err(error) = name_program(&mut command, name)
    {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not name the shell: {error}"
        ));
    }
    command.arg("-c").arg(line);
    without_own_variables(command)
}

/// The command `words` name, run under `arg0` where it is given, without the wrapper's own
/// variables.
fn word_command(arg0: Option<&OsStr>, words: &[OsString]) -> Command {
    let (program, arguments) = words
        .split_first()
        .expect("a form's words were read with a program first");
    let mut command = Command::new(program);
    if let Some(arg0) = arg0
        && let Err(error) = name_program(&mut command, arg0)
    {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not name the command: {error}"
        ));
    }
    command.args(arguments);
    without_own_variables(command)
}

fn without_own_variables(mut command: Command) -> Command {
    for name in OWN_VARIABLES {
        command.env_remove(name);
    }
    command
}

/// Reports a command that could not start, answering `126`, as a shell does.
fn exec_failed(error: &io::Error) -> ExitCode {
    write_error_line(&format!(
        "sidekicks-command-wrapper could not start the command: {error}"
    ));
    ExitCode::from(126)
}

/// Joins the conversation's channel: its records and its requests, both `None`, the command then
/// run uncovered, when no channel is named or joining fails, which is said on standard error.
fn join_channel(process_arguments: &[OsString]) -> (SharedRecords, Option<PartyRequests>) {
    let (records, requests) = match ChannelParty::join(process_arguments) {
        Ok(PartyStart::Joined(party)) => (Some(party.records), Some(party.requests)),
        Ok(PartyStart::Unchanneled) => (None, None),
        Err(error) => {
            write_error_line(&format!(
                "sidekicks-command-wrapper could not join its channel, so the command runs \
                 uncovered: {error}"
            ));
            (None, None)
        }
    };
    let records = Arc::new(Mutex::new(records));
    // The command's own processes that outlive their parent stay below the wrapper.
    if let Err(error) = take_in_orphans() {
        note(
            &records,
            &format!("could not take in its command's orphans: {error}"),
        );
    }
    (records, requests)
}

fn lock_records(records: &Mutex<Option<PartyRecords>>) -> MutexGuard<'_, Option<PartyRecords>> {
    records.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Sends `record`; a failure is said on standard error, since the command runs on whether or not
/// the daemon hears of it.
fn send_record(records: &Mutex<Option<PartyRecords>>, record: &PartyRecord) {
    if let Some(records) = lock_records(records).as_mut()
        && let Err(error) = records.send(record)
    {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not write a record: {error}"
        ));
    }
}

/// Tells the daemon what the wrapper could not do while its command runs on as it is: a record
/// when it joined its channel, else a line on standard error.
fn note(records: &Mutex<Option<PartyRecords>>, message: &str) {
    let mut records = lock_records(records);
    let sent = records.as_mut().map(|records| {
        records.send(&PartyRecord::Warning {
            message: format!("the command wrapper {message}"),
        })
    });
    if !matches!(sent, Some(Ok(()))) {
        write_error_line(&format!("sidekicks-command-wrapper {message}"));
    }
}

/// The record of the command's end with `status`.
fn exited_record(status: ExitStatus) -> PartyRecord {
    PartyRecord::Exited {
        exit_code: status.code(),
        signal: read_child_exit(&status, None).signal_number,
    }
}

/// Where the wrapper's command is, which the signal thread, the daemon's stop and the wait read
/// under one lock, so a stop or a signal never reaches a reaped command's reused id and `Stopped`
/// is sent before `Exited`.
enum CommandState {
    /// Not started yet: a stop signal ends the wrapper as that signal would.
    NotStarted,
    /// Running, leading the process group `group`.
    Running { group: u32 },
    /// Reaped.
    Reaped,
}

type SharedState = Arc<Mutex<CommandState>>;

fn lock_state(state: &Mutex<CommandState>) -> MutexGuard<'_, CommandState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hands each stop signal the wrapper receives to its command's process group from now on: before
/// the command starts, the signal's end is told and taken as the wrapper's own.
fn pass_signals_to_group(state: &SharedState, records: &SharedRecords) {
    let (state, signaled_records) = (Arc::clone(state), Arc::clone(records));
    let started = pass_on_stop_signals(move |signal| match *lock_state(&state) {
        CommandState::NotStarted => {
            send_record(
                &signaled_records,
                &PartyRecord::Exited {
                    exit_code: None,
                    signal: stop_signal_number(signal),
                },
            );
            let error = end_by_stop_signal(signal);
            write_error_line(&format!(
                "sidekicks-command-wrapper could not end by its signal: {error}"
            ));
        }
        CommandState::Running { group } => {
            if let Err(error) = signal_command_group(group, signal) {
                note(
                    &signaled_records,
                    &format!("could not pass a signal on: {error}"),
                );
            }
        }
        CommandState::Reaped => {}
    });
    if let Err(error) = started {
        write_error_line(&format!(
            "sidekicks-command-wrapper cannot pass its signals on: {error}"
        ));
    }
}

/// Runs a provider's line for an agent's `command` with `shell`: its signals passed on from the
/// start, told to the daemon, started once the daemon answers `go` or ten seconds pass, and its end
/// told.
fn run_line_command(
    process_arguments: &[OsString],
    shell: &Path,
    line: &OsStr,
    command: String,
) -> ExitCode {
    let (records, requests) = join_channel(process_arguments);
    let state = Arc::new(Mutex::new(CommandState::NotStarted));
    pass_signals_to_group(&state, &records);
    let stdout_path = read_descriptor_path(io::stdout()).ok();
    send_record(
        &records,
        &PartyRecord::Starting {
            command,
            stdout_path,
            process: None,
        },
    );
    if let Some(mut requests) = requests {
        let deadline = Instant::now() + GO_WAIT;
        loop {
            match requests.next_request(Some(deadline)) {
                Ok(Some(DaemonRequest::Go {})) => break,
                Ok(Some(DaemonRequest::Answer { .. } | DaemonRequest::Stop {})) => {}
                Ok(None) => {
                    write_error_line(
                        "sidekicks-command-wrapper: the daemon did not answer go in time, so the \
                         command runs uncovered",
                    );
                    break;
                }
                Err(error) => {
                    write_error_line(&format!(
                        "sidekicks-command-wrapper could not read its requests, so the command \
                         runs uncovered: {error}"
                    ));
                    break;
                }
            }
        }
    }
    run_child(shell_line(shell, line), &state, &records, None)
}

/// Starts `command` as the wrapper's child leading a process group of its own, follows the
/// daemon's stops in `requests` where given, and tells and takes its end.
fn run_child(
    mut command: Command,
    state: &SharedState,
    records: &SharedRecords,
    requests: Option<PartyRequests>,
) -> ExitCode {
    start_in_own_group(&mut command);
    let mut child = {
        let mut state = lock_state(state);
        match command.spawn() {
            Ok(child) => {
                *state = CommandState::Running { group: child.id() };
                child
            }
            Err(error) => return exec_failed(&error),
        }
    };
    if let Some(requests) = requests {
        let (state, records) = (Arc::clone(state), Arc::clone(records));
        follow_stops(requests, move || {
            // Held until `Stopped` is sent, so the wait's `Exited` comes after it.
            let state = lock_state(&state);
            if let CommandState::Running { group } = *state {
                signal_command_group(group, TerminalSignal::Kill)?;
                send_record(&records, &PartyRecord::Stopped {});
            }
            Ok(())
        });
    }
    let waited = child.wait();
    let mut state = lock_state(state);
    *state = CommandState::Reaped;
    match waited {
        Ok(status) => {
            send_record(records, &exited_record(status));
            end_as_child_ended(status)
        }
        Err(error) => {
            write_error_line(&format!(
                "sidekicks-command-wrapper lost its command: {error}"
            ));
            ExitCode::FAILURE
        }
    }
}

/// Runs a relayed command: told to the daemon by its process handle, then run as the wrapper's
/// child or, with a terminal, in a terminal of its own; the daemon's stop ends it.
fn run_relayed_command(
    process_arguments: &[OsString],
    process: &str,
    arg0: Option<&OsStr>,
    is_tty: bool,
    words: &[OsString],
) -> ExitCode {
    let (records, requests) = join_channel(process_arguments);
    let state = Arc::new(Mutex::new(CommandState::NotStarted));
    if !is_tty {
        pass_signals_to_group(&state, &records);
    }
    send_record(
        &records,
        &PartyRecord::Starting {
            command: words
                .iter()
                .map(|word| word.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            stdout_path: None,
            process: Some(process.to_owned()),
        },
    );
    if is_tty {
        return run_in_terminal(process_arguments, arg0, words, &state, &records, requests);
    }
    run_child(word_command(arg0, words), &state, &records, requests)
}

/// Follows the daemon's requests on a thread of its own, running `stop` at each `Stop`.
fn follow_stops(mut requests: PartyRequests, stop: impl Fn() -> io::Result<()> + Send + 'static) {
    let followed = thread::Builder::new()
        .name("command requests".to_owned())
        .spawn(move || {
            loop {
                match requests.next_request(None) {
                    Ok(Some(DaemonRequest::Stop {})) => {
                        if let Err(error) = stop() {
                            write_error_line(&format!(
                                "sidekicks-command-wrapper could not stop its command: {error}"
                            ));
                        }
                    }
                    Ok(Some(DaemonRequest::Go {} | DaemonRequest::Answer { .. }) | None) => {}
                    Err(error) => {
                        write_error_line(&format!(
                            "sidekicks-command-wrapper stopped reading its requests, so the \
                             daemon cannot stop the command: {error}"
                        ));
                        return;
                    }
                }
            }
        });
    if let Err(error) = followed {
        write_error_line(&format!(
            "sidekicks-command-wrapper cannot follow its requests, so the daemon cannot stop the \
             command: {error}"
        ));
    }
}

/// What the terminal's output thread shares with the reporter: the output's last bytes and when
/// the last came, with the signal each new piece raises.
struct OutputTail {
    bytes: Vec<u8>,
    last_output: Instant,
}

/// The output's tail and the signal its thread raises on each piece.
type SharedTail = Arc<(Mutex<OutputTail>, Condvar)>;

/// Runs a relayed command in a terminal of its own, the wrapper restarted inside it in its inner
/// form: the provider's terminal set raw, bytes copied both ways, the stop signals passed to the
/// inner terminal's foreground group, what its master shows reported on the cheap checks'
/// schedule while the channel is joined, and the daemon's stop ending its whole session.
fn run_in_terminal(
    process_arguments: &[OsString],
    arg0: Option<&OsStr>,
    words: &[OsString],
    state: &SharedState,
    records: &SharedRecords,
    requests: Option<PartyRequests>,
) -> ExitCode {
    let window = match read_standard_input_window_size() {
        Ok(window) => window.unwrap_or(FALLBACK_WINDOW),
        Err(error) => {
            note(
                records,
                &format!("could not read its terminal's size: {error}"),
            );
            FALLBACK_WINDOW
        }
    };
    let program = process_arguments
        .first()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut inner_arguments = vec![INNER_FLAG.to_owned()];
    if let Some(arg0) = arg0 {
        inner_arguments.extend([ARG0_FLAG.to_owned(), arg0.to_string_lossy().into_owned()]);
    }
    inner_arguments.push(WORDS_SEPARATOR.to_owned());
    inner_arguments.extend(words.iter().map(|word| word.to_string_lossy().into_owned()));
    let options = terminal_options(program, inner_arguments, None, HashMap::new());
    let InnerTerminal { pty, device } = match start_inner_terminal(&options, window) {
        Ok(terminal) => terminal,
        Err(error) => return exec_failed(&error),
    };
    *lock_state(state) = CommandState::Running {
        group: pty.child().id(),
    };
    let pty = Arc::new(pty);
    let raw_input = RawStandardInput::enter().unwrap_or_else(|error| {
        note(records, &format!("could not set its terminal raw: {error}"));
        None
    });
    let master = match blocking_terminal_master(&pty) {
        Ok(master) => master,
        Err(error) => return exec_failed(&error),
    };
    let tail: SharedTail = Arc::new((
        Mutex::new(OutputTail {
            bytes: Vec::new(),
            last_output: Instant::now(),
        }),
        Condvar::new(),
    ));
    copy_input(&master);
    let output_ended = copy_output(master, Arc::clone(&tail));
    let (signaled, signaled_records) = (Arc::clone(&pty), Arc::clone(records));
    let started = pass_on_stop_signals(move |signal| {
        if let Err(error) = signal_foreground_group(&signaled, signal) {
            note(
                &signaled_records,
                &format!("could not pass a signal on: {error}"),
            );
        }
    });
    if let Err(error) = started {
        write_error_line(&format!(
            "sidekicks-command-wrapper cannot pass its signals on: {error}"
        ));
    }
    if let Some(requests) = requests {
        let (stopped, records, state) = (Arc::clone(&pty), Arc::clone(records), Arc::clone(state));
        follow_stops(requests, move || {
            // Held until `Stopped` is sent, so the wait's `Exited` comes after it.
            let state = lock_state(&state);
            if matches!(*state, CommandState::Running { .. }) {
                end_terminal_session(&stopped)?;
                send_record(&records, &PartyRecord::Stopped {});
            }
            Ok(())
        });
    }
    if lock_records(records).is_some() {
        report_terminal(
            Arc::clone(&pty),
            device,
            Arc::clone(records),
            Arc::clone(&tail),
        );
    }
    let status = wait_for_terminal_command(&pty);
    let mut state = lock_state(state);
    *state = CommandState::Reaped;
    // The output a command printed just before it exited is still on its way to the provider.
    wait_for_last_output(&output_ended, &tail);
    drop(raw_input);
    match status {
        Ok(status) => {
            send_record(records, &exited_record(status));
            end_as_child_ended(status)
        }
        Err(error) => {
            write_error_line(&format!(
                "sidekicks-command-wrapper lost its command: {error}"
            ));
            ExitCode::FAILURE
        }
    }
}

/// Waits for the output copier to end, which it does once every descriptor on the terminal's
/// program side closed; stops at the first `OUTPUT_QUIET` with no output, as a background process
/// holding the terminal open keeps it from ending, and at `OUTPUT_DRAIN_CAP` past the command's
/// exit whatever comes.
fn wait_for_last_output(output_ended: &mpsc::Receiver<()>, tail: &SharedTail) {
    let cap = Instant::now() + OUTPUT_DRAIN_CAP;
    loop {
        let left = cap.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        match output_ended.recv_timeout(OUTPUT_QUIET.min(left)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                let last_output = tail
                    .0
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .last_output;
                if last_output.elapsed() >= OUTPUT_QUIET {
                    return;
                }
            }
        }
    }
}

/// Copies what is typed into the provider's terminal into the command's, on a thread of its own.
fn copy_input(master: &std::fs::File) {
    let mut master = match master.try_clone() {
        Ok(master) => master,
        Err(error) => {
            write_error_line(&format!(
                "sidekicks-command-wrapper cannot pass its input on: {error}"
            ));
            return;
        }
    };
    let copied = thread::Builder::new()
        .name("command input".to_owned())
        .spawn(move || {
            let mut input = io::stdin().lock();
            let mut buffer = [0_u8; 4096];
            loop {
                // The provider's terminal closing ends the input, as a read error does.
                match input.read(&mut buffer) {
                    Ok(0) | Err(_) => return,
                    Ok(count) => {
                        if master.write_all(&buffer[..count]).is_err() {
                            return;
                        }
                    }
                }
            }
        });
    if let Err(error) = copied {
        write_error_line(&format!(
            "sidekicks-command-wrapper cannot pass its input on: {error}"
        ));
    }
}

/// Copies the command's output into the provider's terminal on a thread of its own, keeping its last
/// bytes in `tail`; the receiver hears once the output has ended.
fn copy_output(mut master: std::fs::File, tail: SharedTail) -> mpsc::Receiver<()> {
    let (ended, output_ended) = mpsc::channel();
    let copied = thread::Builder::new()
        .name("command output".to_owned())
        .spawn(move || {
            let mut output = io::stdout().lock();
            let mut buffer = [0_u8; 4096];
            // The master answers an error once the command's side has closed.
            while let Ok(count) = master.read(&mut buffer)
                && count > 0
            {
                let piece = &buffer[..count];
                if output
                    .write_all(piece)
                    .and_then(|()| output.flush())
                    .is_err()
                {
                    break;
                }
                let (kept, piece_came) = &*tail;
                let mut kept = kept.lock().unwrap_or_else(PoisonError::into_inner);
                kept.bytes.extend_from_slice(piece);
                let excess = kept.bytes.len().saturating_sub(OUTPUT_TAIL_BYTES);
                kept.bytes.drain(..excess);
                kept.last_output = Instant::now();
                piece_came.notify_one();
            }
            // The receiver is gone once the wrapper stopped waiting, which leaves no one to tell.
            ended.send(()).unwrap_or_default();
        });
    if let Err(error) = copied {
        write_error_line(&format!(
            "sidekicks-command-wrapper cannot pass its output on: {error}"
        ));
    }
    output_ended
}

/// Reports what the command's terminal master shows and the output's tail on a thread of its own,
/// at the cheap checks' delays after the last output, each output re-arming them so nothing is
/// read while output flows, and only when it changed since the last report.
fn report_terminal(
    pty: Arc<alacritty_terminal::tty::Pty>,
    device: sidekicks_platforms::TerminalDevice,
    records: SharedRecords,
    tail: SharedTail,
) {
    let records_for_failure = Arc::clone(&records);
    let reported = thread::Builder::new()
        .name("command terminal".to_owned())
        .spawn(move || {
            let peer_failure_noted = Once::new();
            let mut last_report = None;
            let (kept, piece_came) = &*tail;
            let mut armed_at = kept
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .last_output;
            let mut checks_done = 0;
            loop {
                let output_tail = {
                    let tail = kept.lock().unwrap_or_else(PoisonError::into_inner);
                    if tail.last_output != armed_at {
                        armed_at = tail.last_output;
                        checks_done = 0;
                    }
                    let due = armed_at + cheap_check_delay(checks_done);
                    let now = Instant::now();
                    if now < due {
                        drop(
                            piece_came
                                .wait_timeout(tail, due - now)
                                .unwrap_or_else(PoisonError::into_inner),
                        );
                        continue;
                    }
                    String::from_utf8_lossy(&tail.bytes).into_owned()
                };
                checks_done += 1;
                let master = match read_terminal_master(&pty, &peer_failure_noted) {
                    Ok(master) => master,
                    // The terminal closes once its command ends, which ends the reports.
                    Err(_closed) => return,
                };
                let report = (master, output_tail);
                if last_report.as_ref() != Some(&report) {
                    send_record(
                        &records,
                        &PartyRecord::Terminal {
                            device,
                            master: report.0,
                            output_tail: report.1.clone(),
                        },
                    );
                    last_report = Some(report);
                }
            }
        });
    if let Err(error) = reported {
        note(
            &records_for_failure,
            &format!("cannot report its terminal: {error}"),
        );
    }
}

#[cfg(test)]
mod tests;
