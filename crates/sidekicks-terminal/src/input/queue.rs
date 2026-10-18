//! A terminal's writes in order: each write and answer joins one intake as it is handed over, and
//! the read loop takes them into a queue bounded in bytes, writing the head as the terminal takes
//! input.

use std::collections::VecDeque;
use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use tokio::sync::{mpsc, oneshot};

use crate::input::answers::AnswerBytes;

/// The most bytes a terminal's write queue takes: a write is taken from the intake while the queue
/// holds fewer, so a write of any size is taken whole once there is room.
pub(crate) const WRITE_QUEUE_BYTES: usize = 64 * 1024;

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

/// The answer a write is waiting for: taken or written, or the error that left it unwritten.
pub(crate) type WriteAnswer = oneshot::Sender<Result<(), TerminalWriteError>>;

/// The intake every write and answer of one terminal joins, in the order they are handed over;
/// unbounded, since a write joins it at once under its caller's lock, and bounded in practice by
/// the callers' own windows and the answers' bound.
pub(crate) type WriteIntake = mpsc::UnboundedSender<QueuedWrite>;

/// One write in a terminal's intake, in the order it was handed over: its bytes, who waits for
/// its take into the queue or for its last byte, the answer bytes it holds against the answers'
/// bound while it is not written, and for a key that may go as a signal, its claim.
pub(crate) struct QueuedWrite {
    bytes: Bytes,
    taken: Option<WriteAnswer>,
    written: Option<WriteAnswer>,
    answer_bytes: Option<AnswerBytes>,
    signal_key: Option<Arc<SignalKeyClaim>>,
}

impl QueuedWrite {
    /// A write whose caller waits until the queue takes it, answered through `taken`.
    pub(crate) fn awaiting_take(bytes: Bytes, taken: WriteAnswer) -> Self {
        Self {
            bytes,
            taken: Some(taken),
            written: None,
            answer_bytes: None,
            signal_key: None,
        }
    }

    /// A write whose caller waits until its last byte is written, answered through `written`.
    pub(crate) fn awaiting_written(bytes: Bytes, written: WriteAnswer) -> Self {
        Self {
            bytes,
            taken: None,
            written: Some(written),
            answer_bytes: None,
            signal_key: None,
        }
    }

    /// An answer to the program, whose bytes count against the answers' bound until written.
    pub(crate) fn answer(bytes: Bytes, answer_bytes: AnswerBytes) -> Self {
        Self {
            bytes,
            taken: None,
            written: None,
            answer_bytes: Some(answer_bytes),
            signal_key: None,
        }
    }

    /// The one-byte write `key` in its place in line, which `claim` answers: written there unless
    /// the read loop sends it as its signal first.
    pub(crate) fn signal_key(key: u8, claim: Arc<SignalKeyClaim>) -> Self {
        Self {
            bytes: Bytes::from(vec![key]),
            taken: None,
            written: None,
            answer_bytes: None,
            signal_key: Some(claim),
        }
    }
}

/// Where a key that may go as a signal stands.
enum SignalKeyState {
    /// Not yet written: the take's answer until the queue takes the key or it goes as its signal,
    /// and whether it may still go as one.
    Unwritten {
        taken: Option<WriteAnswer>,
        may_signal: bool,
    },
    /// Sent as its signal, so it is never written.
    Signaled,
    /// Written to the terminal.
    Written,
    /// Left unwritten by a failed write or the terminal's stop, so it never goes as its signal.
    Refused,
}

/// One key handed over alone, which the terminal's settings may turn into a signal: while it is
/// not yet written and the terminal refuses input, the read loop sends it as that signal, so it
/// reaches a program that reads none of its input; otherwise it is written in its place in line.
pub(crate) struct SignalKeyClaim {
    state: Mutex<SignalKeyState>,
}

impl SignalKeyClaim {
    /// A claim whose take is answered through `taken`.
    pub(crate) fn new(taken: WriteAnswer) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SignalKeyState::Unwritten {
                taken: Some(taken),
                may_signal: true,
            }),
        })
    }

    /// Sends the key as its signal through `send` while it is not yet written, answering its take
    /// unless the queue already took it. A key `send` does not turn into a signal stays in line,
    /// and so does one whose signal failed, logged and never tried again.
    pub(crate) fn send_as_signal(&self, send: impl FnOnce() -> io::Result<bool>) {
        let mut state = self.lock_state();
        let SignalKeyState::Unwritten { taken, may_signal } = &mut *state else {
            return;
        };
        if !*may_signal {
            return;
        }
        match send() {
            Ok(false) => {}
            Ok(true) => {
                if let Some(taken) = taken.take() {
                    answer_write(taken, Ok(()));
                }
                *state = SignalKeyState::Signaled;
            }
            Err(error) => {
                *may_signal = false;
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a key could not be sent as its signal, so it is written in line"
                );
            }
        }
    }

    /// Whether the key was written or went as its signal, so nothing more is decided for it.
    pub(crate) fn is_settled(&self) -> bool {
        !matches!(*self.lock_state(), SignalKeyState::Unwritten { .. })
    }

    /// The queue taking the key in its place in line.
    fn take_in_line(&self) -> KeyInLine {
        match &mut *self.lock_state() {
            SignalKeyState::Unwritten { taken, .. } => KeyInLine::Waiting(taken.take()),
            SignalKeyState::Signaled | SignalKeyState::Written | SignalKeyState::Refused => {
                KeyInLine::Settled
            }
        }
    }

    fn is_signaled(&self) -> bool {
        matches!(*self.lock_state(), SignalKeyState::Signaled)
    }

    fn mark_written(&self) {
        *self.lock_state() = SignalKeyState::Written;
    }

    /// Settles a key the queue drops unwritten, unless it already went as its signal.
    fn mark_refused(&self) {
        let mut state = self.lock_state();
        if matches!(*state, SignalKeyState::Unwritten { .. }) {
            *state = SignalKeyState::Refused;
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, SignalKeyState> {
        self.state
            .lock()
            .expect("no panic holds a key's claim, since a panic ends the daemon")
    }
}

/// What the queue finds when it reaches a signal key in line.
enum KeyInLine {
    /// The key went as its signal, or was refused, so it is not written.
    Settled,
    /// The key is written in its place; its take, unless already answered, is answered here.
    Waiting(Option<WriteAnswer>),
}

/// One write waiting for the terminal, and how much of it is written.
struct PendingWrite {
    bytes: Bytes,
    written: usize,
    answer: Option<WriteAnswer>,
    /// Held until the write leaves the queue; dropped with it.
    answer_bytes: Option<AnswerBytes>,
    signal_key: Option<Arc<SignalKeyClaim>>,
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
            mut taken,
            written,
            answer_bytes,
            signal_key,
        } = write;
        if let Some(claim) = &signal_key {
            let KeyInLine::Waiting(waiting) = claim.take_in_line() else {
                return;
            };
            taken = waiting;
        }
        if let Some(stop) = self.stop {
            if let Some(claim) = &signal_key {
                claim.mark_refused();
            }
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
            answer_bytes,
            signal_key,
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
            return;
        }
        if let Some(claim) = &head.signal_key {
            claim.mark_written();
        }
        if let Some(answer_bytes) = &head.answer_bytes {
            answer_bytes.count_written();
        }
        if let Some(answer) = head.answer {
            answer_write(answer, Ok(()));
        }
    }

    /// Drops the keys that went as their signals while they waited, unwritten, in the queue.
    pub(crate) fn drop_signaled_keys(&mut self) {
        let mut dropped = 0;
        self.pending.retain(|write| {
            let is_signaled = write
                .signal_key
                .as_ref()
                .is_some_and(|claim| claim.is_signaled());
            if is_signaled {
                dropped += write.bytes.len() - write.written;
            }
            !is_signaled
        });
        self.pending_byte_count -= dropped;
    }

    /// Answers every waiting write, a partly written one included, as closed, and every later one.
    pub(crate) fn close(&mut self) {
        self.stop_with(WriteStop::Closed);
    }

    /// Answers every waiting write, a partly written one included, as ended, and every later one.
    pub(crate) fn end(&mut self) {
        self.stop_with(WriteStop::Ended);
    }

    /// Answers every waiting write with `error`, shared among them, and settles every key among
    /// them as refused; later writes are taken as before.
    pub(crate) fn fail(&mut self, error: io::Error) {
        let error = Arc::new(error);
        self.refuse_pending(|| TerminalWriteError::Failed(Arc::clone(&error)));
    }

    fn stop_with(&mut self, stop: WriteStop) {
        self.stop = Some(stop);
        self.refuse_pending(|| stop.error());
    }

    /// Drops every waiting write unwritten, answering each with `error()` and settling each key
    /// as refused, so none goes as its signal later.
    fn refuse_pending(&mut self, error: impl Fn() -> TerminalWriteError) {
        self.pending_byte_count = 0;
        for write in self.pending.drain(..) {
            if let Some(claim) = &write.signal_key {
                claim.mark_refused();
            }
            if let Some(answer) = write.answer {
                answer_write(answer, Err(error()));
            }
        }
    }
}

/// Sends a write's answer; a writer that stopped waiting has dropped its receiver, which is not an
/// error.
pub(crate) fn answer_write(answer: WriteAnswer, result: Result<(), TerminalWriteError>) {
    if answer.send(result).is_err() {
        tracing::debug!("a terminal write's answer had no reader: its writer stopped waiting");
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use bytes::Bytes;
    use rstest::rstest;
    use tokio::sync::mpsc;
    use tokio::sync::oneshot::{self, error::TryRecvError};

    use super::{
        QueuedWrite, SignalKeyClaim, TerminalWriteError, WRITE_QUEUE_BYTES, WriteIntake, WriteQueue,
    };

    /// What a write's caller receives.
    pub(crate) type Answer = oneshot::Receiver<Result<(), TerminalWriteError>>;

    fn push(queue: &mut WriteQueue, bytes: &'static [u8]) -> Answer {
        let (answer, receiver) = oneshot::channel();
        queue.push(QueuedWrite::awaiting_written(
            Bytes::from_static(bytes),
            answer,
        ));
        receiver
    }

    /// Hands `bytes` to the intake as a write whose caller waits for its take.
    pub(crate) fn hand_over(intake: &WriteIntake, bytes: Bytes) -> Answer {
        let (taken, receiver) = oneshot::channel();
        assert!(
            intake
                .send(QueuedWrite::awaiting_take(bytes, taken))
                .is_ok(),
            "the intake is open"
        );
        receiver
    }

    /// Writes every byte the queue holds, in order, as the terminal would.
    pub(crate) fn write_all(queue: &mut WriteQueue) -> Vec<u8> {
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

    pub(crate) fn is_written(receiver: &mut Answer) -> bool {
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
    fn a_signal_key_goes_as_its_signal_until_it_is_written_and_never_both() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let mut queue = WriteQueue::new();

        // A key taken into the queue and signaled before its turn is answered once, never written.
        let _first = hand_over(&intake, Bytes::from_static(b"a"));
        let (taken, mut key) = oneshot::channel();
        let claim = SignalKeyClaim::new(taken);
        assert!(
            intake
                .send(QueuedWrite::signal_key(b'x', Arc::clone(&claim)))
                .is_ok()
        );
        let _last = hand_over(&intake, Bytes::from_static(b"b"));
        claim.send_as_signal(|| Ok(false));
        queue.take_from(&mut receiver);
        assert!(is_written(&mut key), "the queue's take answers the key");
        claim.send_as_signal(|| Ok(true));
        queue.drop_signaled_keys();
        assert_eq!(write_all(&mut queue), b"ab");

        // A key written in line is never sent as its signal afterwards.
        let (taken, _key) = oneshot::channel();
        let claim = SignalKeyClaim::new(taken);
        assert!(
            intake
                .send(QueuedWrite::signal_key(b'y', Arc::clone(&claim)))
                .is_ok()
        );
        queue.take_from(&mut receiver);
        assert_eq!(write_all(&mut queue), b"y");
        let mut is_sent = false;
        claim.send_as_signal(|| {
            is_sent = true;
            Ok(true)
        });
        assert!(!is_sent && claim.is_settled());

        // A key a failed write drains from the queue is never sent as its signal afterwards.
        let _blocked = hand_over(&intake, Bytes::from_static(b"c"));
        let (taken, _key) = oneshot::channel();
        let claim = SignalKeyClaim::new(taken);
        assert!(
            intake
                .send(QueuedWrite::signal_key(b'z', Arc::clone(&claim)))
                .is_ok()
        );
        queue.take_from(&mut receiver);
        queue.fail(std::io::Error::other("the terminal refused the write"));
        let mut is_sent = false;
        claim.send_as_signal(|| {
            is_sent = true;
            Ok(true)
        });
        assert!(!is_sent && claim.is_settled());
    }
}
