//! The screen copy's answers to a program's questions on their way to the terminal: at most
//! [`ANSWER_BYTES_LIMIT`] of them wait unwritten, and where the system counts the input waiting on
//! a shell's console, newer answers also drop while that count has stopped falling.

use std::error::Error;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use tokio::runtime::Handle;

use crate::input::queue::{QueuedWrite, WriteIntake};

/// The most bytes of the screen copy's answers one shell holds before the terminal has written
/// them; an answer past it is dropped, so a program that asks without reading its input cannot
/// grow the intake, and answers a caller holds back for a while keep to the same bound. It is also
/// how many answer bytes, written or dropped, come between two readings of a console's waiting
/// input.
pub const ANSWER_BYTES_LIMIT: usize = 64 * 1024;

/// Reads how many input events wait unread on a shell's console, through the console helper;
/// fails with the helper's error.
pub(crate) type ConsoleInputRead =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = io::Result<u32>> + Send>> + Send + Sync>;

/// A shell's console, read once after each [`ANSWER_BYTES_LIMIT`] of answers written or dropped:
/// while its waiting input count has not fallen since the reading before, the program reads none
/// of its input, so newer answers are dropped. Dropped answers count toward the next reading like
/// written ones, so the answers start again once a reading finds the count fallen, and a program
/// that keeps asking costs one reading per bound of its answers, never one per answer.
struct ConsoleInputWatch {
    read: ConsoleInputRead,
    runtime: Handle,
    /// The answer bytes written or dropped since the last reading was asked for.
    answered_since_reading: AtomicUsize,
    /// Set while a reading runs, so at most one runs at a time.
    is_reading: AtomicBool,
    /// The last count read, which the next reading is weighed against.
    last_count: Mutex<Option<u32>>,
    /// Set while the last two readings found the count not fallen.
    is_input_stalled: AtomicBool,
}

impl ConsoleInputWatch {
    /// Starts a reading unless one is running; its answer sets whether the input has stalled, and
    /// a failed reading leaves the answers flowing, logged.
    fn ask_for_reading(self: &Arc<Self>) {
        if self.is_reading.swap(true, Ordering::SeqCst) {
            return;
        }
        let watch = Arc::clone(self);
        let reading = (self.read)();
        self.runtime.spawn(async move {
            match reading.await {
                Ok(count) => {
                    let mut last_count = watch
                        .last_count
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    let is_stalled = last_count.is_some_and(|previous| count >= previous);
                    *last_count = Some(count);
                    watch.is_input_stalled.store(is_stalled, Ordering::SeqCst);
                }
                Err(error) => {
                    watch.is_input_stalled.store(false, Ordering::SeqCst);
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a shell's console could not be read, so its answers are not held back"
                    );
                }
            }
            watch.is_reading.store(false, Ordering::SeqCst);
        });
    }

    /// Counts `length` answer bytes written or dropped, asking for a reading after each
    /// [`ANSWER_BYTES_LIMIT`].
    fn count_answered(self: &Arc<Self>, length: usize) {
        let before =
            self.answered_since_reading
                .update(Ordering::SeqCst, Ordering::SeqCst, |answered| {
                    let answered = answered + length;
                    if answered >= ANSWER_BYTES_LIMIT {
                        0
                    } else {
                        answered
                    }
                });
        if before + length >= ANSWER_BYTES_LIMIT {
            self.ask_for_reading();
        }
    }
}

/// The count of one terminal's answer bytes not yet written, whether a dropped answer was logged
/// since the count was last zero, and the console watched where the system counts its input.
struct AnswerCount {
    bytes: AtomicUsize,
    has_logged_drop: AtomicBool,
    console: Option<Arc<ConsoleInputWatch>>,
}

/// Bytes of an answer held against the count until the write leaves the queue, written or
/// refused; dropping it gives them back.
pub(crate) struct AnswerBytes {
    count: Arc<AnswerCount>,
    length: usize,
}

impl AnswerBytes {
    /// Counts the answer as written toward the console's next reading; an answer refused with a
    /// failed write or the terminal's stop counts toward none.
    pub(crate) fn count_written(&self) {
        if let Some(console) = &self.count.console {
            console.count_answered(self.length);
        }
    }
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
    /// Answers handed into `intake`, none yet waiting; with `console_read`, the shell's console is
    /// read on `runtime` after each [`ANSWER_BYTES_LIMIT`] of answers written or dropped.
    pub(crate) fn new(
        intake: WriteIntake,
        console_read: Option<ConsoleInputRead>,
        runtime: &Handle,
    ) -> Self {
        Self {
            intake,
            count: Arc::new(AnswerCount {
                bytes: AtomicUsize::new(0),
                has_logged_drop: AtomicBool::new(false),
                console: console_read.map(|read| {
                    Arc::new(ConsoleInputWatch {
                        read,
                        runtime: runtime.clone(),
                        answered_since_reading: AtomicUsize::new(0),
                        is_reading: AtomicBool::new(false),
                        last_count: Mutex::new(None),
                        is_input_stalled: AtomicBool::new(false),
                    })
                }),
            }),
        }
    }

    /// Queues `answer` for the program behind every earlier write, unless the answers not yet
    /// written would pass [`ANSWER_BYTES_LIMIT`] or the shell's console shows its program reading
    /// none of its input: then it is dropped, logged once until every answer waiting has been
    /// written, and counted toward the console's next reading. Nothing is queued once the terminal
    /// has closed.
    pub fn queue(&self, answer: Bytes) {
        if answer.is_empty() {
            return;
        }
        let length = answer.len();
        let console = self.count.console.as_ref();
        let is_input_stalled =
            console.is_some_and(|console| console.is_input_stalled.load(Ordering::SeqCst));
        let has_room = !is_input_stalled
            && self
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
            if let Some(console) = console {
                console.count_answered(length);
            }
            return;
        }
        let write = QueuedWrite::answer(
            answer,
            AnswerBytes {
                count: Arc::clone(&self.count),
                length,
            },
        );
        if self.intake.send(write).is_err() {
            tracing::debug!("an answer came after the terminal's read loop ended");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;
    use tokio::runtime::Handle;
    use tokio::sync::mpsc;

    use super::{ANSWER_BYTES_LIMIT, ConsoleInputRead, TerminalAnswers};
    use crate::input::queue::WriteQueue;
    use crate::input::queue::tests::{hand_over, is_written, write_all};

    const ANSWER: &[u8] = b"\x1b[?1;2c";

    /// Writes everything the queue takes from the intake, as a terminal that reads all would.
    fn write_everything(
        queue: &mut WriteQueue,
        receiver: &mut mpsc::UnboundedReceiver<crate::input::queue::QueuedWrite>,
    ) -> Vec<u8> {
        let mut written = Vec::new();
        loop {
            queue.take_from(receiver);
            let drained = write_all(queue);
            if drained.is_empty() {
                return written;
            }
            written.extend_from_slice(&drained);
        }
    }

    #[tokio::test]
    async fn writes_and_answers_reach_the_program_in_the_order_handed_over() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let answers = TerminalAnswers::new(intake.clone(), None, &Handle::current());
        let mut queue = WriteQueue::new();
        let paste = Bytes::from(vec![b'p'; 200 * 1024]);

        let _first = hand_over(&intake, Bytes::from_static(b"one"));
        answers.queue(Bytes::from_static(ANSWER));
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

    #[tokio::test]
    async fn answers_stop_at_their_bound_while_keystrokes_still_queue() {
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let answers = TerminalAnswers::new(intake.clone(), None, &Handle::current());
        let answer = Bytes::from_static(ANSWER);
        let fitting = ANSWER_BYTES_LIMIT / answer.len();

        // A program that asks far more than it reads: answers past the bound are dropped.
        for _ in 0..fitting + 10 {
            answers.queue(answer.clone());
        }
        assert!(answers.count.has_logged_drop.load(Ordering::SeqCst));
        let _keystroke = hand_over(&intake, Bytes::from_static(b"q"));

        let written = write_everything(&mut WriteQueue::new(), &mut receiver);
        let mut expected = answer.repeat(fitting);
        expected.push(b'q');
        assert_eq!(
            written, expected,
            "the keystroke after the dropped answers arrives"
        );

        // Every answer written, the count is back to zero and the next drop logs again.
        assert_eq!(answers.count.bytes.load(Ordering::SeqCst), 0);
        assert!(!answers.count.has_logged_drop.load(Ordering::SeqCst));
    }

    /// Waits until no console reading runs.
    async fn reading_done(answers: &TerminalAnswers) {
        let console = answers
            .count
            .console
            .as_ref()
            .expect("the answers watch a console");
        while console.is_reading.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn answers_drop_while_the_console_s_waiting_input_has_not_fallen() {
        let counts = Arc::new(Mutex::new(VecDeque::from([40, 40, 12])));
        let read_counts = Arc::clone(&counts);
        let console_read: ConsoleInputRead = Arc::new(move || {
            let count = read_counts
                .lock()
                .expect("no test panics while holding the counts")
                .pop_front()
                .expect("the test reads no more counts than it holds");
            Box::pin(async move { Ok(count) })
        });
        let readings_left = || counts.lock().expect("no test panicked").len();
        let (intake, mut receiver) = mpsc::unbounded_channel();
        let answers = TerminalAnswers::new(intake, Some(console_read), &Handle::current());
        let answer = Bytes::from_static(ANSWER);
        let fitting = ANSWER_BYTES_LIMIT / answer.len();

        // Answers refused by the terminal's stop count toward no reading.
        let mut stopped = WriteQueue::new();
        answers.queue(answer.clone());
        write_everything(&mut stopped, &mut receiver);
        for _ in 0..fitting {
            answers.queue(answer.clone());
        }
        stopped.take_from(&mut receiver);
        stopped.close();
        assert_eq!(readings_left(), 3, "a stop's answers ask for no reading");

        // Two bounds of answers written: two readings, the second finding the count not fallen.
        let mut queue = WriteQueue::new();
        for _ in 0..2 {
            for _ in 0..=fitting {
                answers.queue(answer.clone());
                write_everything(&mut queue, &mut receiver);
            }
            reading_done(&answers).await;
        }
        assert_eq!(readings_left(), 1);

        // A program that keeps asking while its input has stalled: its answers drop, and a
        // thousand of them start no reading of their own.
        for _ in 0..1_000 {
            answers.queue(answer.clone());
        }
        assert!(
            write_everything(&mut queue, &mut receiver).is_empty(),
            "an answer while the console's input has stalled is dropped"
        );
        assert_eq!(readings_left(), 1, "dropped answers start no reading each");

        // The drops that complete a bound ask for one reading, which finds the count fallen.
        let mut dropped = 1_000;
        while readings_left() == 1 && dropped <= fitting {
            answers.queue(answer.clone());
            dropped += 1;
        }
        assert_eq!(
            readings_left(),
            0,
            "a bound of dropped answers asks for one reading"
        );
        reading_done(&answers).await;
        answers.queue(answer.clone());
        assert_eq!(write_everything(&mut queue, &mut receiver), ANSWER);
    }
}
