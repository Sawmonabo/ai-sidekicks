//! A relayed command run in a terminal of its own: the wrapper restarted inside it, bytes copied
//! both ways between it and the provider's terminal, and what its master shows reported.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read as _, Write as _};
use std::process::ExitCode;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, Once, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::Pty;
use sidekicks_platforms::{
    RawStandardInput, TerminalOutputWatch, blocking_terminal_master, end_terminal_session,
    pass_on_stop_signals, read_standard_input_window_size, read_terminal_master,
    signal_foreground_group, start_inner_terminal, terminal_options, wait_for_exit,
    wait_for_terminal_command,
};

use super::{
    ARG0_FLAG, CommandState, INNER_FLAG, SharedRecords, SharedState, WORDS_SEPARATOR,
    end_as_command_ended, exec_failed, exited_record, follow_stops, lock_records, lock_state, note,
    send_record,
};
use crate::provider::command::channel::PartyRecord;
use crate::provider::command::channel::party::PartyRequests;
use crate::provider::command::waiting_checks::cheap_check_delay;
use crate::standard_error::write_error_line;

/// The window a command's terminal opens at when the wrapper's own standard input is no terminal.
const FALLBACK_WINDOW: WindowSize = WindowSize {
    num_lines: 24,
    num_cols: 80,
    cell_width: 0,
    cell_height: 0,
};

/// How many of the command's last output bytes the wrapper keeps for its last line: 1 KiB, more
/// than the last line of a terminal's screen holds, which is where a prompt sits.
const OUTPUT_TAIL_BYTES: usize = 1024;

/// How long the output copier waits for more output, once the terminal's command exited, before it
/// takes the output as ended: 10 ms, a wait short enough that no one sees it.
const OUTPUT_QUIET: Duration = Duration::from_millis(10);

/// The longest the wrapper drains a terminal whose output keeps coming after its command exited, as
/// a background process holding the terminal open can make it: 2 s.
const OUTPUT_DRAIN_CAP: Duration = Duration::from_secs(2);

/// What the terminal's output thread shares with the reporter and the wrapper: the output's last
/// bytes and when the last came, with the signal each new piece raises, and whether the command
/// exited, after which the copier ends at the first quiet `OUTPUT_QUIET`.
struct OutputTail {
    bytes: Vec<u8>,
    last_output: Instant,
    has_command_exited: bool,
}

/// The output's tail and the signal its thread raises on each piece.
type SharedTail = Arc<(Mutex<OutputTail>, Condvar)>;

/// Runs a relayed command in a terminal of its own, the wrapper restarted inside it in its inner
/// form: the provider's terminal set raw, bytes copied both ways, the stop signals passed to the
/// inner terminal's foreground group, what its master shows reported on the cheap checks'
/// schedule while the channel is joined, and the daemon's stop ending its whole session.
pub(super) fn run_in_terminal(
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
    let terminal = match start_inner_terminal(&options, window) {
        Ok(terminal) => terminal,
        Err(error) => return exec_failed(&error),
    };
    *lock_state(state) = CommandState::Running {
        group: terminal.pty.child().id(),
    };
    // The rest of `terminal`, its own handle on the program side among it, lives until the
    // wrapper returns, so the master never reads as closed while the command runs.
    let pty = Arc::new(terminal.pty);
    let master = match blocking_terminal_master(&pty) {
        Ok(master) => master,
        Err(error) => return abandon_terminal(&pty, &error),
    };
    let output_watch = match TerminalOutputWatch::new(&master) {
        Ok(output_watch) => Arc::new(output_watch),
        Err(error) => return abandon_terminal(&pty, &error),
    };
    // Nothing returns before the input is left as it was, below.
    let raw_input = RawStandardInput::enter().unwrap_or_else(|error| {
        note(records, &format!("could not set its terminal raw: {error}"));
        None
    });
    let tail: SharedTail = Arc::new((
        Mutex::new(OutputTail {
            bytes: Vec::new(),
            last_output: Instant::now(),
            has_command_exited: false,
        }),
        Condvar::new(),
    ));
    copy_input(&master);
    let output_ended = copy_output(master, Arc::clone(&output_watch), Arc::clone(&tail));
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
        follow_stops(requests, Arc::clone(&records), move || {
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
            terminal.device,
            Arc::clone(records),
            Arc::clone(&tail),
        );
    }
    // The command stays unreaped until its state reads reaped, so no stop reaches a reused id.
    let exited = wait_for_exit(pty.child().id(), None);
    tail.0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .has_command_exited = true;
    // Set before the wake, so a copier woken from its wait reads the exit.
    if let Err(error) = output_watch.wake() {
        note(
            records,
            &format!("could not wake its output copier at its command's exit: {error}"),
        );
    }
    let mut state = lock_state(state);
    *state = CommandState::Reaped;
    let status = exited.and_then(|_| wait_for_terminal_command(&pty));
    // The output a command printed just before it exited is still on its way to the provider.
    // The cap passing, or a copier that never started, leaves nothing more to wait for.
    if let Ok(Err(error)) = output_ended.recv_timeout(OUTPUT_DRAIN_CAP) {
        note(
            records,
            &format!("could not tell whether its command's output is all copied: {error}"),
        );
    }
    if let Some(raw_input) = raw_input
        && let Err(error) = raw_input.leave()
    {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not put its terminal back from raw: {error}"
        ));
    }
    match status {
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

/// Ends the session of a terminal whose command already started, which the wrapper cannot relay
/// for `failure`, and answers that failure's exit.
fn abandon_terminal(pty: &Pty, failure: &io::Error) -> ExitCode {
    if let Err(error) = end_terminal_session(pty) {
        write_error_line(&format!(
            "sidekicks-command-wrapper could not end its command's terminal: {error}"
        ));
    }
    exec_failed(failure)
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

/// Copies the command's output into the provider's terminal on a thread of its own, keeping its
/// last bytes in `tail`, until every descriptor on the terminal's program side closed or, once the
/// command exited, no output comes for `OUTPUT_QUIET`, as a background process holding the
/// terminal open keeps it from closing. It reads only once `output_watch` sees output, so the
/// wake at the exit reaches it; the receiver hears once the output has ended, with the error that
/// kept the copier from telling whether more was coming.
fn copy_output(
    mut master: std::fs::File,
    output_watch: Arc<TerminalOutputWatch>,
    tail: SharedTail,
) -> mpsc::Receiver<io::Result<()>> {
    let (ended, output_ended) = mpsc::channel();
    let copied = thread::Builder::new()
        .name("command output".to_owned())
        .spawn(move || {
            let mut output = io::stdout().lock();
            let mut buffer = [0_u8; 4096];
            let (kept, piece_came) = &*tail;
            let mut copied = Ok(());
            loop {
                let has_command_exited = kept
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .has_command_exited;
                match output_watch.wait(has_command_exited.then_some(OUTPUT_QUIET)) {
                    Ok(true) => {}
                    // Woken by the exit, the copier reads the flag again.
                    Ok(false) if !has_command_exited => continue,
                    Ok(false) => break,
                    Err(error) => {
                        copied = Err(error);
                        break;
                    }
                }
                // The master answers an error once the command's side has closed.
                let Ok(count) = master.read(&mut buffer) else {
                    break;
                };
                if count == 0 {
                    break;
                }
                let piece = &buffer[..count];
                if output
                    .write_all(piece)
                    .and_then(|()| output.flush())
                    .is_err()
                {
                    break;
                }
                let mut kept = kept.lock().unwrap_or_else(PoisonError::into_inner);
                kept.bytes.extend_from_slice(piece);
                let excess = kept.bytes.len().saturating_sub(OUTPUT_TAIL_BYTES);
                kept.bytes.drain(..excess);
                kept.last_output = Instant::now();
                piece_came.notify_one();
            }
            // The receiver is gone once the wrapper stopped waiting, which leaves no one to tell.
            ended.send(copied).unwrap_or_default();
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
    pty: Arc<Pty>,
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
