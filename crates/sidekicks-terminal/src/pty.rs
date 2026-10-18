//! A shell's PTY: how it opens, the environment it hands the `shell` mode, and the intake and
//! queue that carry writes and the screen copy's answers to the terminal in order.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::{self, Pty};
use bytes::Bytes;
use tokio::sync::{mpsc, oneshot};

/// The most bytes a terminal's write queue takes: a write is taken from the intake while the queue
/// holds fewer, so a write of any size is taken whole once there is room.
pub(crate) const WRITE_QUEUE_BYTES: usize = 64 * 1024;

/// The most bytes of the screen copy's answers one shell holds before the terminal has written
/// them; an answer past it is dropped, so a program that asks without reading its input cannot
/// grow the intake, and answers a caller holds back for a while keep to the same bound.
pub const ANSWER_BYTES_LIMIT: usize = 64 * 1024;

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
    /// A name is never empty and holds no `=`, and no name or value holds a NUL.
    pub environment: Vec<(String, String)>,
    /// The folder the shell starts in.
    pub working_directory: PathBuf,
    /// The terminal's height in rows.
    pub rows: u16,
    /// The terminal's width in columns.
    pub columns: u16,
    /// The daemon's `shell` mode with its arguments up to the shell's program, which starts
    /// the shell with exactly `environment`.
    pub shell_start: CommandLine,
}

/// Opens the shell's PTY and starts its program through the `shell` mode; blocking, so it
/// runs on the daemon's spawner thread. Fails with `InvalidInput` for an environment entry with
/// an empty name, an `=` in its name or a NUL, with `NotADirectory` when the working folder is not
/// a folder, and with the system's error when the terminal cannot be opened or the program
/// started.
pub(crate) fn open_pty(request: &SpawnRequest) -> io::Result<Pty> {
    check_environment(&request.environment)?;
    if !request.working_directory.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("{} is not a folder", request.working_directory.display()),
        ));
    }
    let mut arguments = request.shell_start.arguments.clone();
    arguments.push(request.program.clone());
    arguments.extend(request.arguments.iter().cloned());
    let options = sidekicks_platforms::terminal_options(
        tty::Shell::new(request.shell_start.program.clone(), arguments),
        Some(request.working_directory.clone()),
        encode_shell_environment(&request.environment),
    );
    let window_size = WindowSize {
        num_lines: request.rows,
        num_cols: request.columns,
        cell_width: 0,
        cell_height: 0,
    };
    tty::new(&options, window_size, 0)
}

/// Refuses an environment the `shell` mode could not hand on as given: an empty name, an `=`
/// in a name, or a NUL anywhere.
fn check_environment(environment: &[(String, String)]) -> io::Result<()> {
    for (index, (name, value)) in environment.iter().enumerate() {
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            // The value may hold a secret, so the error names only the entry.
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "shell environment entry {index} has an empty name, an `=` in its name or \
                     a NUL"
                ),
            ));
        }
    }
    Ok(())
}

/// The variable that tells the `shell` mode how many environment entries it was handed.
const SHELL_ENVIRONMENT_COUNT: &str = "SIDEKICKS_SHELL_ENVIRONMENT_COUNT";

/// The start of every variable that carries one entry of a shell's environment to the
/// `shell` mode; the entry's index in the environment follows it.
const SHELL_ENVIRONMENT_PREFIX: &str = "SIDEKICKS_SHELL_ENVIRONMENT_";

/// The name of the variable that carries entry `index` of a shell's environment.
fn shell_environment_name(index: usize) -> String {
    format!("{SHELL_ENVIRONMENT_PREFIX}{index}")
}

/// The variables that carry `environment` to the `shell` mode: the count, then one
/// `NAME=VALUE` each, in order, a later entry's value replacing an earlier one's of the same name
/// in its place.
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
    let count = resolved.len();
    resolved
        .into_iter()
        .enumerate()
        .map(|(index, (name, value))| (shell_environment_name(index), format!("{name}={value}")))
        .chain([(SHELL_ENVIRONMENT_COUNT.to_owned(), count.to_string())])
        .collect()
}

/// Why the environment the `shell` mode was handed could not be read.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ShellEnvironmentError {
    /// No variable says how many entries were handed over.
    #[error("the shell environment's count is missing")]
    CountMissing,
    /// The count is not a decimal number.
    #[error("the shell environment's count is not a number")]
    CountInvalid,
    /// An entry below the count has no variable.
    #[error("shell environment entry {index} is missing")]
    IndexMissing {
        /// The entry's index.
        index: usize,
    },
    /// An entry is not Unicode.
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
}

/// Reads a shell's environment, in order, from the variables the daemon handed the `shell`
/// mode, reading only the entries below the count it was handed, so any other variable, a stray
/// inherited entry among them, is ignored. Fails when the count is missing or not a number, or an
/// entry below it is missing, not Unicode or holds no `=`.
pub fn shell_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Vec<(String, String)>, ShellEnvironmentError> {
    let variables: HashMap<OsString, OsString> = variables.into_iter().collect();
    let count = variables
        .get(OsStr::new(SHELL_ENVIRONMENT_COUNT))
        .ok_or(ShellEnvironmentError::CountMissing)?
        .to_str()
        .and_then(|count| count.parse::<usize>().ok())
        .ok_or(ShellEnvironmentError::CountInvalid)?;
    (0..count)
        .map(|index| {
            let entry = variables
                .get(OsStr::new(&shell_environment_name(index)))
                .ok_or(ShellEnvironmentError::IndexMissing { index })?
                .to_str()
                // The value may hold a secret, so the error names only the entry.
                .ok_or(ShellEnvironmentError::NotUnicode { index })?;
            let (name, value) = entry
                .split_once('=')
                .ok_or(ShellEnvironmentError::NoSeparator { index })?;
            Ok((name.to_owned(), value.to_owned()))
        })
        .collect()
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

/// The answer a write is waiting for: written whole, or the error that left it unwritten.
type WriteAnswer = oneshot::Sender<Result<(), TerminalWriteError>>;

/// One write in a terminal's intake, in the order it was handed over: its bytes, who waits for
/// its take into the queue or for its last byte, and the answer count it holds while it is not
/// written.
pub(crate) struct QueuedWrite {
    bytes: Bytes,
    taken: Option<WriteAnswer>,
    written: Option<WriteAnswer>,
    answer_bytes: Option<AnswerBytes>,
}

impl QueuedWrite {
    /// A write whose caller waits until the queue takes it, answered through `taken`.
    pub(crate) fn awaiting_take(bytes: Bytes, taken: WriteAnswer) -> Self {
        Self {
            bytes,
            taken: Some(taken),
            written: None,
            answer_bytes: None,
        }
    }

    /// A write whose caller waits until its last byte is written, answered through `written`.
    pub(crate) fn awaiting_written(bytes: Bytes, written: WriteAnswer) -> Self {
        Self {
            bytes,
            taken: None,
            written: Some(written),
            answer_bytes: None,
        }
    }
}

/// The intake every write and answer of one terminal joins, in the order they are handed over;
/// unbounded, since a write joins it at once under its caller's lock, and bounded in practice by
/// the callers' own windows and [`ANSWER_BYTES_LIMIT`].
pub(crate) type WriteIntake = mpsc::UnboundedSender<QueuedWrite>;

/// The count of one terminal's answer bytes not yet written, and whether a dropped answer was
/// logged since the count was last zero.
struct AnswerCount {
    bytes: AtomicUsize,
    has_logged_drop: AtomicBool,
}

/// Bytes of an answer held against the count until the write leaves the queue, written or
/// refused; dropping it gives them back.
struct AnswerBytes {
    count: Arc<AnswerCount>,
    length: usize,
}

impl Drop for AnswerBytes {
    fn drop(&mut self) {
        let before = self.count.bytes.fetch_sub(self.length, Ordering::SeqCst);
        if before == self.length {
            self.count.has_logged_drop.store(false, Ordering::SeqCst);
        }
    }
}

/// Where a shell's screen copy hands its answers to the program's questions: into the terminal's
/// intake behind every write handed over before them, at most [`ANSWER_BYTES_LIMIT`] of them
/// waiting. The read loop takes them before it next waits.
#[derive(Clone)]
pub struct TerminalAnswers {
    intake: WriteIntake,
    count: Arc<AnswerCount>,
}

impl TerminalAnswers {
    /// Answers handed into `intake`, none yet waiting.
    pub(crate) fn new(intake: WriteIntake) -> Self {
        Self {
            intake,
            count: Arc::new(AnswerCount {
                bytes: AtomicUsize::new(0),
                has_logged_drop: AtomicBool::new(false),
            }),
        }
    }

    /// Queues `answer` for the program behind every earlier write, unless the answers not yet
    /// written would pass [`ANSWER_BYTES_LIMIT`]: then it is dropped, logged once until every
    /// answer waiting has been written. Nothing is queued once the terminal has closed.
    pub fn queue(&self, answer: Bytes) {
        if answer.is_empty() {
            return;
        }
        let length = answer.len();
        let has_room = self
            .count
            .bytes
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |waiting| {
                (waiting + length <= ANSWER_BYTES_LIMIT).then_some(waiting + length)
            })
            .is_ok();
        if !has_room {
            if !self.count.has_logged_drop.swap(true, Ordering::SeqCst) {
                tracing::warn!(
                    limit = ANSWER_BYTES_LIMIT,
                    "a program asked its terminal more than it read, so later answers are dropped"
                );
            }
            return;
        }
        let write = QueuedWrite {
            bytes: answer,
            taken: None,
            written: None,
            answer_bytes: Some(AnswerBytes {
                count: Arc::clone(&self.count),
                length,
            }),
        };
        if self.intake.send(write).is_err() {
            tracing::debug!("an answer came after the terminal's read loop ended");
        }
    }
}

/// One write waiting for the terminal, and how much of it is written.
struct PendingWrite {
    bytes: Bytes,
    written: usize,
    answer: Option<WriteAnswer>,
    /// Held until the write leaves the queue; dropped with it.
    _answer_bytes: Option<AnswerBytes>,
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
    /// The bytes the waiting writes still hold.
    pending_byte_count: usize,
    stop: Option<WriteStop>,
}

impl WriteQueue {
    /// An open queue holding no write.
    pub(crate) fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            pending_byte_count: 0,
            stop: None,
        }
    }

    /// Whether the queue takes another write: it holds fewer than [`WRITE_QUEUE_BYTES`] bytes.
    pub(crate) fn has_room(&self) -> bool {
        self.pending_byte_count < WRITE_QUEUE_BYTES
    }

    /// Takes writes from `intake` in order while the queue has room, answering each one's take.
    pub(crate) fn take_from(&mut self, intake: &mut mpsc::UnboundedReceiver<QueuedWrite>) {
        while self.has_room()
            && let Ok(write) = intake.try_recv()
        {
            self.push(write);
        }
    }

    /// Queues `write` behind every earlier write and answers its take; once the queue is closed
    /// or ended the write is answered with that error at once, and an empty write is answered
    /// written at once.
    fn push(&mut self, write: QueuedWrite) {
        let QueuedWrite {
            bytes,
            taken,
            written,
            answer_bytes,
        } = write;
        if let Some(stop) = self.stop {
            if let Some(taken) = taken {
                answer_write(taken, Err(stop.error()));
            }
            if let Some(written) = written {
                answer_write(written, Err(stop.error()));
            }
            return;
        }
        if let Some(taken) = taken {
            answer_write(taken, Ok(()));
        }
        if bytes.is_empty() {
            if let Some(written) = written {
                answer_write(written, Ok(()));
            }
            return;
        }
        self.pending_byte_count += bytes.len();
        self.pending.push_back(PendingWrite {
            bytes,
            written: 0,
            answer: written,
            _answer_bytes: answer_bytes,
        });
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
        self.pending_byte_count -= written;
        if head.written < head.bytes.len() {
            self.pending.push_front(head);
        } else if let Some(answer) = head.answer {
            answer_write(answer, Ok(()));
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
        self.pending_byte_count = 0;
        for write in self.pending.drain(..) {
            if let Some(answer) = write.answer {
                answer_write(answer, Err(TerminalWriteError::Failed(Arc::clone(&error))));
            }
        }
    }

    fn stop_with(&mut self, stop: WriteStop) {
        self.stop = Some(stop);
        self.pending_byte_count = 0;
        for write in self.pending.drain(..) {
            if let Some(answer) = write.answer {
                answer_write(answer, Err(stop.error()));
            }
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
    use std::io;

    use bytes::Bytes;
    use rstest::rstest;
    use tokio::sync::mpsc;
    use tokio::sync::oneshot::{self, error::TryRecvError};

    use super::{
        ANSWER_BYTES_LIMIT, QueuedWrite, ShellEnvironmentError, TerminalAnswers,
        TerminalWriteError, WRITE_QUEUE_BYTES, WriteQueue, check_environment,
        encode_shell_environment, shell_environment, shell_environment_name,
    };

    type Answer = oneshot::Receiver<Result<(), TerminalWriteError>>;

    fn push(queue: &mut WriteQueue, bytes: &'static [u8]) -> Answer {
        let (answer, receiver) = oneshot::channel();
        queue.push(QueuedWrite::awaiting_written(
            Bytes::from_static(bytes),
            answer,
        ));
        receiver
    }

    /// Hands `bytes` to the intake as a write whose caller waits for its take.
    fn hand_over(intake: &mpsc::UnboundedSender<QueuedWrite>, bytes: Bytes) -> Answer {
        let (taken, receiver) = oneshot::channel();
        intake
            .send(QueuedWrite::awaiting_take(bytes, taken))
            .expect("the intake is open");
        receiver
    }

    /// Writes every byte the queue holds, in order, as the terminal would.
    fn write_all(queue: &mut WriteQueue) -> Vec<u8> {
        let mut written = Vec::new();
        while let Some(pending) = queue.pending_bytes() {
            written.extend_from_slice(pending);
            let count = pending.len();
            queue.advance(count);
        }
        written
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
    fn a_write_is_answered_once_the_queue_takes_it_and_waits_while_the_queue_is_full() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let mut queue = WriteQueue::new();
        let half = Bytes::from(vec![b'a'; WRITE_QUEUE_BYTES / 2]);

        // A program that never reads: nothing is written, yet the writes the queue has room for
        // are answered.
        let mut first = hand_over(&intake, half.clone());
        let mut second = hand_over(&intake, half.clone());
        let mut third = hand_over(&intake, half);
        queue.take_from(&mut receiver);
        assert!(is_written(&mut first));
        assert!(is_written(&mut second));
        assert!(
            is_waiting(&mut third),
            "a write past the bound waits for room"
        );

        // The program reads: the queue drains and the waiting write is taken.
        queue.advance(WRITE_QUEUE_BYTES / 2);
        queue.take_from(&mut receiver);
        assert!(is_written(&mut third));
    }

    #[test]
    fn writes_and_answers_reach_the_program_in_the_order_handed_over() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let answers = TerminalAnswers::new(intake.clone());
        let mut queue = WriteQueue::new();
        let paste = Bytes::from(vec![b'p'; 200 * 1024]);

        let _first = hand_over(&intake, Bytes::from_static(b"one"));
        answers.queue(Bytes::from_static(b"\x1b[?1;2c"));
        let _second = hand_over(&intake, Bytes::from_static(b"two"));
        let mut pasted = hand_over(&intake, paste.clone());
        queue.take_from(&mut receiver);
        assert!(
            is_written(&mut pasted),
            "a paste larger than the bound is taken whole"
        );

        let mut expected = b"one\x1b[?1;2ctwo".to_vec();
        expected.extend_from_slice(&paste);
        assert_eq!(write_all(&mut queue), expected);
    }

    #[test]
    fn answers_stop_at_their_bound_while_keystrokes_still_queue() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let answers = TerminalAnswers::new(intake.clone());
        let answer = Bytes::from_static(b"\x1b[?1;2c");
        let fitting = ANSWER_BYTES_LIMIT / answer.len();

        // A program that asks far more than it reads: answers past the bound are dropped.
        for _ in 0..fitting + 10 {
            answers.queue(answer.clone());
        }
        assert!(
            answers
                .count
                .has_logged_drop
                .load(std::sync::atomic::Ordering::SeqCst)
        );
        let _keystroke = hand_over(&intake, Bytes::from_static(b"q"));

        let mut queue = WriteQueue::new();
        let mut written = Vec::new();
        loop {
            queue.take_from(&mut receiver);
            let drained = write_all(&mut queue);
            if drained.is_empty() {
                break;
            }
            written.extend_from_slice(&drained);
        }
        let mut expected = answer.repeat(fitting);
        expected.push(b'q');
        assert_eq!(
            written, expected,
            "the keystroke after the dropped answers arrives"
        );

        // Every answer written, the count is back to zero and the next drop logs again.
        assert_eq!(
            answers
                .count
                .bytes
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(
            !answers
                .count
                .has_logged_drop
                .load(std::sync::atomic::Ordering::SeqCst)
        );
    }

    #[test]
    fn the_shell_mode_reads_back_exactly_the_environment_it_was_handed() {
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
                // An unrelated variable and an entry past the count, as a parent's leftover.
                .chain([
                    (OsString::from("HOME"), OsString::from("/home/someone")),
                    (
                        OsString::from(shell_environment_name(3)),
                        OsString::from("STRAY=1"),
                    ),
                ])
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

        // An entry the encoding could not carry as given is refused before any shell starts.
        for (name, value) in [("", "x"), ("A=B", "x"), ("A\0", "x"), ("A", "x\0")] {
            let refused = check_environment(&[(name.to_owned(), value.to_owned())]);
            assert_eq!(
                refused.map_err(|error| error.kind()),
                Err(io::ErrorKind::InvalidInput)
            );
        }
    }
}
