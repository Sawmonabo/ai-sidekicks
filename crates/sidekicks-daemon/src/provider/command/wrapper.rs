//! The `sidekicks-command-wrapper` mode a provider runs every shell command through. A line that is
//! no agent's command (a hook, a status line, a tool server's start) is run at once by the POSIX
//! shell, `sh -c <line>`, and nothing else. An agent's command is told to the daemon over the
//! conversation's channel, started in a process group of its own (an agent's line by the shell the
//! provider wrote it for), its stop signals passed on to that group and its end told and taken as
//! the wrapper's own; one the provider starts with a terminal runs in a terminal the wrapper opens,
//! whose master the wrapper holds, so it copies bytes both ways and reports what the master shows.
//! The wrapper runs no runtime and keeps no log: blocking reads and writes, one signal thread and a
//! thread per copy; what it could not do goes to the daemon as a record, and on standard error
//! where it changes how the command runs.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sidekicks_platforms::{
    POSIX_SHELL, TerminalSignal, end_as_child_ended, end_by_stop_signal, exec_command,
    name_program, pass_on_stop_signals, read_child_exit, read_descriptor_path, run_foreground_job,
    signal_command_group, start_in_own_group, stop_signal_number, take_in_orphans, wait_for_exit,
};

use crate::mutex_lock::lock;
use crate::provider::command::channel::party::{
    ChannelParty, PartyRecords, PartyRequests, PartyStart, RequestError, own_arguments,
};
use crate::provider::command::channel::{DaemonRequest, PARTY_SECRET_VARIABLE, PartyRecord};
use crate::provider::driver::shell_prefix_command_of;
use crate::standard_error::write_error_line;
use terminal::run_in_terminal;

/// The name of the link a provider runs every shell command through, which reaches this mode.
pub(crate) const COMMAND_WRAPPER_PROGRAM_NAME: &str = "sidekicks-command-wrapper";

/// The variable naming the provider whose shell prefix the wrapper serves, so it reads that
/// provider's line shape.
pub(crate) const COMMAND_PROVIDER_VARIABLE: &str = "SIDEKICKS_COMMAND_PROVIDER";

/// How long the wrapper waits for the daemon's `go` before it runs the command uncovered.
const GO_WAIT: Duration = Duration::from_secs(10);

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
    /// The wrapper started again inside the command's terminal, the session's leader, which runs
    /// the words as the terminal's foreground job and ends as they ended.
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
                    Path::new(POSIX_SHELL),
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
            match run_foreground_job(&mut word_command(arg0.as_deref(), &words)) {
                Ok(status) => end_as_command_ended(status),
                Err(error) => exec_failed(&error),
            }
        }
    }
}

/// The shell `variable` names by its absolute path, which the provider wrote an agent's line for;
/// the POSIX shell, said on standard error, where it names none.
fn named_shell(variable: &str) -> PathBuf {
    match std::env::var_os(variable).map(PathBuf::from) {
        Some(shell) if shell.is_absolute() && shell.is_file() => shell,
        named => {
            let named =
                named.map_or_else(|| "nothing".to_owned(), |named| named.display().to_string());
            write_error_line(&format!(
                "sidekicks-command-wrapper runs the command with {POSIX_SHELL}, \
                 since {variable} names {named}, no shell's absolute path"
            ));
            PathBuf::from(POSIX_SHELL)
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

/// Sends `record`; a failure is said on standard error, since the command runs on whether or not
/// the daemon hears of it.
fn send_record(records: &Mutex<Option<PartyRecords>>, record: &PartyRecord) {
    if let Some(records) = lock(records).as_mut()
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
    let mut records = lock(records);
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

/// Ends the wrapper as its command ended with `status`, saying on standard error where it could
/// not end by the command's signal, and answering the code it exits with then.
fn end_as_command_ended(status: ExitStatus) -> ExitCode {
    let (code, failure) = end_as_child_ended(status);
    if let Some(error) = failure {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not end by its command's signal: {error}"
        ));
    }
    code
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

/// Hands each stop signal the wrapper receives to its command's process group from now on: before
/// the command starts, the signal's end is told and taken as the wrapper's own.
fn pass_signals_to_group(state: &SharedState, records: &SharedRecords) {
    let (state, signaled_records) = (Arc::clone(state), Arc::clone(records));
    let started = pass_on_stop_signals(move |signal| match *lock(&state) {
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
                Err(RequestError::Unreadable(error)) => {
                    note(
                        &records,
                        &format!("lost a request from the daemon: {error}"),
                    );
                }
                Err(RequestError::Watch(error)) => {
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
        let mut state = lock(state);
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
        follow_stops(requests, Arc::clone(&records), move || {
            // Held until `Stopped` is sent, so the wait's `Exited` comes after it.
            let state = lock(&state);
            if let CommandState::Running { group } = *state {
                signal_command_group(group, TerminalSignal::Kill)?;
                send_record(&records, &PartyRecord::Stopped {});
            }
            Ok(())
        });
    }
    // The child stays unreaped until its state reads reaped, so no stop reaches a reused id.
    let exited = wait_for_exit(child.id(), None);
    let mut state = lock(state);
    *state = CommandState::Reaped;
    let waited = exited.and_then(|_| child.wait());
    match waited {
        Ok(status) => {
            send_record(records, &exited_record(status));
            end_as_command_ended(status)
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

/// Follows the daemon's requests on a thread of its own, running `stop` at each `Stop`; a request
/// that cannot be read is told to the daemon through `records`.
fn follow_stops(
    mut requests: PartyRequests,
    records: SharedRecords,
    stop: impl Fn() -> io::Result<()> + Send + 'static,
) {
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
                    Err(RequestError::Unreadable(error)) => {
                        note(
                            &records,
                            &format!("lost a request from the daemon: {error}"),
                        );
                    }
                    Err(RequestError::Watch(error)) => {
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

mod terminal;

#[cfg(test)]
mod tests;
