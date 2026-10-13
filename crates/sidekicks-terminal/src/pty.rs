//! A shell's PTY: how it opens, the environment it hands the `shell-start` mode, and the queue that
//! carries writes to the terminal in order.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::{self, Pty};
use bytes::Bytes;
use tokio::sync::oneshot;

/// A program and the arguments it starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandLine {
    /// The program to run.
    pub program: String,
    /// The arguments it starts with, in order.
    pub arguments: Vec<String>,
}

/// What one shell starts as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    /// The shell's program.
    pub program: String,
    /// The arguments the shell's program starts with.
    pub arguments: Vec<String>,
    /// Exactly the shell's environment, in order; a later entry with a name already given wins.
    pub environment: Vec<(String, String)>,
    /// The folder the shell starts in.
    pub working_directory: PathBuf,
    /// The terminal's height in rows.
    pub rows: u16,
    /// The terminal's width in columns.
    pub columns: u16,
    /// The daemon's `shell-start` mode with its arguments through `--`, which execs the shell with
    /// exactly `environment`; without it (Windows) the shell also inherits the daemon's own
    /// environment beneath `environment`.
    pub shell_start: Option<CommandLine>,
}

/// Opens the shell's PTY and starts its program; blocking, so it runs on the daemon's spawner
/// thread, never a runtime thread. Fails when the terminal cannot be opened or the program started.
pub(crate) fn open_pty(request: &SpawnRequest) -> io::Result<Pty> {
    let (shell, environment) = match &request.shell_start {
        Some(shell_start) => {
            let mut arguments = shell_start.arguments.clone();
            arguments.push(request.program.clone());
            arguments.extend(request.arguments.iter().cloned());
            (
                tty::Shell::new(shell_start.program.clone(), arguments),
                encode_shell_environment(&request.environment),
            )
        }
        None => (
            tty::Shell::new(request.program.clone(), request.arguments.clone()),
            request.environment.iter().cloned().collect(),
        ),
    };
    let options = sidekicks_platforms::terminal_options(
        shell,
        Some(request.working_directory.clone()),
        environment,
    );
    let window_size = WindowSize {
        num_lines: request.rows,
        num_cols: request.columns,
        cell_width: 0,
        cell_height: 0,
    };
    tty::new(&options, window_size, 0)
}

/// The start of every variable that carries one entry of a shell's environment to the
/// `shell-start` mode; the entry's index in the environment follows it.
pub const SHELL_ENVIRONMENT_PREFIX: &str = "SIDEKICKS_SHELL_ENVIRONMENT_";

/// The name of the variable that carries entry `index` of a shell's environment.
fn shell_environment_name(index: usize) -> String {
    format!("{SHELL_ENVIRONMENT_PREFIX}{index}")
}

/// The variables that carry `environment` to the `shell-start` mode, one `NAME=VALUE` each, in
/// order, a later entry's value replacing an earlier one's of the same name in its place.
fn encode_shell_environment(environment: &[(String, String)]) -> HashMap<String, String> {
    let mut resolved: Vec<(&str, &str)> = Vec::with_capacity(environment.len());
    let mut position_of_name: HashMap<&str, usize> = HashMap::with_capacity(environment.len());
    for (name, value) in environment {
        match position_of_name.entry(name.as_str()) {
            Entry::Occupied(position) => resolved[*position.get()].1 = value.as_str(),
            Entry::Vacant(position) => {
                position.insert(resolved.len());
                resolved.push((name.as_str(), value.as_str()));
            }
        }
    }
    resolved
        .into_iter()
        .enumerate()
        .map(|(index, (name, value))| (shell_environment_name(index), format!("{name}={value}")))
        .collect()
}

/// Why the environment the `shell-start` mode was handed could not be read.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ShellEnvironmentError {
    /// An entry's value is not Unicode.
    #[error("shell environment entry {index} is not Unicode")]
    NotUnicode {
        /// The entry's index.
        index: usize,
    },
    /// An entry holds no `=` after its name.
    #[error("shell environment entry {index} holds no `=` after its name")]
    NoSeparator {
        /// The entry's index.
        index: usize,
    },
    /// An entry's index is past any the environment can hold.
    #[error("shell environment index {index_text} is too large")]
    IndexTooLarge {
        /// The index as the variable's name spells it.
        index_text: String,
    },
    /// Two variables name the same index.
    #[error("shell environment entry {index} is given twice")]
    IndexRepeated {
        /// The repeated index.
        index: usize,
    },
    /// An index below the highest one given has no entry.
    #[error("shell environment entry {index} is missing")]
    IndexMissing {
        /// The first index with no entry.
        index: usize,
    },
}

/// Reads a shell's environment, in order, from the variables the daemon handed the `shell-start`
/// mode, ignoring every other variable; fails when an entry is not Unicode, holds no `=` after its
/// name, or the indices given are not exactly `0..n`.
pub fn shell_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Vec<(String, String)>, ShellEnvironmentError> {
    let mut entries: BTreeMap<usize, (String, String)> = BTreeMap::new();
    for (name, value) in variables {
        let Some(index_digits) = name
            .as_encoded_bytes()
            .strip_prefix(SHELL_ENVIRONMENT_PREFIX.as_bytes())
        else {
            continue;
        };
        if index_digits.is_empty() || !index_digits.iter().all(u8::is_ascii_digit) {
            continue;
        }
        let index =
            decimal_index(index_digits).ok_or_else(|| ShellEnvironmentError::IndexTooLarge {
                index_text: String::from_utf8_lossy(index_digits).into_owned(),
            })?;
        let entry = value.into_string().map_err(|_not_unicode| {
            // The value may hold a secret, so the error names only the entry.
            ShellEnvironmentError::NotUnicode { index }
        })?;
        let separator = entry
            .char_indices()
            .skip(1)
            .find_map(|(position, character)| (character == '=').then_some(position))
            .ok_or(ShellEnvironmentError::NoSeparator { index })?;
        let pair = (
            entry[..separator].to_owned(),
            entry[separator + 1..].to_owned(),
        );
        if entries.insert(index, pair).is_some() {
            return Err(ShellEnvironmentError::IndexRepeated { index });
        }
    }
    let mut environment = Vec::with_capacity(entries.len());
    for (expected, (index, pair)) in entries.into_iter().enumerate() {
        if index != expected {
            return Err(ShellEnvironmentError::IndexMissing { index: expected });
        }
        environment.push(pair);
    }
    Ok(environment)
}

/// The index ASCII decimal `digits` spell, or `None` past `usize`.
fn decimal_index(digits: &[u8]) -> Option<usize> {
    digits.iter().try_fold(0_usize, |index, digit| {
        index
            .checked_mul(10)?
            .checked_add(usize::from(digit - b'0'))
    })
}

/// Why a write to a terminal was not made.
#[derive(Debug, thiserror::Error)]
pub enum TerminalWriteError {
    /// The terminal was closed before the write was made.
    #[error("the terminal closed before this write")]
    Closed,
    /// The terminal's input ended, its other side having hung up, before the write was made.
    #[error("the terminal's input ended before this write")]
    Ended,
    /// The system refused the write.
    #[error("the write to the terminal failed")]
    Failed(#[source] Arc<io::Error>),
}

/// The answer a write is waiting for.
type WriteAnswer = oneshot::Sender<Result<(), TerminalWriteError>>;

/// One write waiting for the terminal, and how much of it is written.
struct PendingWrite {
    bytes: Bytes,
    written: usize,
    answer: WriteAnswer,
}

/// Why a queue takes no more writes.
#[derive(Clone, Copy)]
enum WriteStop {
    Closed,
    Ended,
}

impl WriteStop {
    fn error(self) -> TerminalWriteError {
        match self {
            Self::Closed => TerminalWriteError::Closed,
            Self::Ended => TerminalWriteError::Ended,
        }
    }
}

/// A terminal's writes in order, the head the one in flight; each is answered once all its bytes
/// are written, or with the error that left it unwritten.
pub(crate) struct WriteQueue {
    pending: VecDeque<PendingWrite>,
    stop: Option<WriteStop>,
}

impl WriteQueue {
    /// An open queue holding no write.
    pub(crate) fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            stop: None,
        }
    }

    /// Queues `bytes` behind every earlier write; once the queue is closed or ended the write is
    /// answered with that error at once, and an empty write is answered at once.
    pub(crate) fn push(&mut self, bytes: Bytes, answer: WriteAnswer) {
        if let Some(stop) = self.stop {
            answer_write(answer, Err(stop.error()));
        } else if bytes.is_empty() {
            answer_write(answer, Ok(()));
        } else {
            self.pending.push_back(PendingWrite {
                bytes,
                written: 0,
                answer,
            });
        }
    }

    /// The bytes of the head write not yet written; `None` with no write waiting.
    pub(crate) fn pending_bytes(&self) -> Option<&[u8]> {
        self.pending
            .front()
            .map(|write| &write.bytes[write.written..])
    }

    /// Records that `written` bytes of the head write were written, answering it once it is whole;
    /// `written` is at most what [`Self::pending_bytes`] gave.
    pub(crate) fn advance(&mut self, written: usize) {
        let mut head = self
            .pending
            .pop_front()
            .expect("a write is advanced only after its pending bytes were offered");
        head.written += written;
        if head.written < head.bytes.len() {
            self.pending.push_front(head);
        } else {
            answer_write(head.answer, Ok(()));
        }
    }

    /// Answers every waiting write, a partly written one included, as closed, and every later one.
    pub(crate) fn close(&mut self) {
        self.stop_with(WriteStop::Closed);
    }

    /// Answers every waiting write, a partly written one included, as ended, and every later one.
    pub(crate) fn end(&mut self) {
        self.stop_with(WriteStop::Ended);
    }

    /// Answers every waiting write with `error`, shared among them; later writes are taken as
    /// before.
    pub(crate) fn fail(&mut self, error: io::Error) {
        let error = Arc::new(error);
        for write in self.pending.drain(..) {
            answer_write(
                write.answer,
                Err(TerminalWriteError::Failed(Arc::clone(&error))),
            );
        }
    }

    fn stop_with(&mut self, stop: WriteStop) {
        self.stop = Some(stop);
        for write in self.pending.drain(..) {
            answer_write(write.answer, Err(stop.error()));
        }
    }
}

/// Sends a write's answer; a writer that stopped waiting has dropped its receiver, which is not an
/// error.
fn answer_write(answer: WriteAnswer, result: Result<(), TerminalWriteError>) {
    if answer.send(result).is_err() {
        tracing::debug!("a terminal write's answer had no reader: its writer stopped waiting");
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;

    use bytes::Bytes;
    use rstest::rstest;
    use tokio::sync::oneshot::{self, error::TryRecvError};

    use super::{
        ShellEnvironmentError, TerminalWriteError, WriteQueue, encode_shell_environment,
        shell_environment, shell_environment_name,
    };

    type Answer = oneshot::Receiver<Result<(), TerminalWriteError>>;

    fn push(queue: &mut WriteQueue, bytes: &'static [u8]) -> Answer {
        let (answer, receiver) = oneshot::channel();
        queue.push(Bytes::from_static(bytes), answer);
        receiver
    }

    fn is_waiting(receiver: &mut Answer) -> bool {
        matches!(receiver.try_recv(), Err(TryRecvError::Empty))
    }

    fn is_written(receiver: &mut Answer) -> bool {
        matches!(receiver.try_recv(), Ok(Ok(())))
    }

    fn is_closed(error: &TerminalWriteError) -> bool {
        matches!(error, TerminalWriteError::Closed)
    }

    fn is_ended(error: &TerminalWriteError) -> bool {
        matches!(error, TerminalWriteError::Ended)
    }

    type Stop = (fn(&mut WriteQueue), fn(&TerminalWriteError) -> bool);

    #[rstest]
    // A full terminal leaves the rest of the head write waiting, and writes answer in order.
    #[case::waits_while_full_in_order(None)]
    // After a close no byte is written: the partly written head, the queued write and a later one
    // are all refused.
    #[case::never_after_close(Some((
        WriteQueue::close as fn(&mut WriteQueue),
        is_closed as fn(&TerminalWriteError) -> bool,
    )))]
    #[case::never_after_end(Some((
        WriteQueue::end as fn(&mut WriteQueue),
        is_ended as fn(&TerminalWriteError) -> bool,
    )))]
    fn writes_go_in_order_and_never_after_the_terminal_stops(#[case] stop: Option<Stop>) {
        let mut queue = WriteQueue::new();
        let mut first = push(&mut queue, b"abcd");
        let mut second = push(&mut queue, b"ef");

        queue.advance(2);
        assert!(is_waiting(&mut first));
        assert!(is_waiting(&mut second));
        assert_eq!(queue.pending_bytes(), Some(&b"cd"[..]));

        if let Some((stop, is_refusal)) = stop {
            stop(&mut queue);
            for receiver in [&mut first, &mut second] {
                assert!(matches!(receiver.try_recv(), Ok(Err(error)) if is_refusal(&error)));
            }
            assert_eq!(queue.pending_bytes(), None);
            let mut later = push(&mut queue, b"gh");
            assert!(matches!(later.try_recv(), Ok(Err(error)) if is_refusal(&error)));
            assert_eq!(queue.pending_bytes(), None);
        } else {
            queue.advance(2);
            assert!(is_written(&mut first));
            assert!(is_waiting(&mut second));
            assert_eq!(queue.pending_bytes(), Some(&b"ef"[..]));
            queue.advance(2);
            assert!(is_written(&mut second));
            assert_eq!(queue.pending_bytes(), None);
        }
    }

    #[test]
    fn the_shell_start_mode_reads_back_exactly_the_environment_it_was_handed() {
        let environment = [
            ("PATH", "/bin"),
            ("EQUATION", "a=b\nc"),
            ("PATH", "/usr/bin"),
            ("LANG", "en_US.UTF-8"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        let encoded = encode_shell_environment(&environment);
        let variables = |encoded: &HashMap<String, String>| {
            encoded
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .chain([(OsString::from("HOME"), OsString::from("/home/someone"))])
                .collect::<Vec<_>>()
        };

        let decoded = shell_environment(variables(&encoded));
        let expected = [
            ("PATH", "/usr/bin"),
            ("EQUATION", "a=b\nc"),
            ("LANG", "en_US.UTF-8"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        assert_eq!(decoded, Ok(expected.to_vec()));

        let mut missing_one = encoded;
        missing_one.remove(&shell_environment_name(1));
        assert_eq!(
            shell_environment(variables(&missing_one)),
            Err(ShellEnvironmentError::IndexMissing { index: 1 })
        );
    }
}
