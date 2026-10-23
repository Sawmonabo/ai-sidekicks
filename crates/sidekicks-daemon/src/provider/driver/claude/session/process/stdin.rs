//! The one writer of a Claude Code process's input. Every line, a user message, a control request,
//! an answer or a withdrawal, goes through one ordered queue that one task drains, so lines never
//! interleave and a caller that stops waiting never leaves half a line. Each line is flushed
//! before the next is taken, so a failure reports how far its own line got: nothing reached the
//! pipe, or some of it may have.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery,
};

// A line's place: waiting in the queue, being written, or given up by its caller before the
// writer took it, which the writer then skips.
const QUEUED: u8 = 0;
const WRITING: u8 = 1;
const ABANDONED: u8 = 2;

// One line waiting for the writer. A line enqueued without an answer has no state and no sender.
struct PendingLine {
    bytes: Vec<u8>,
    state: Option<Arc<AtomicU8>>,
    done: Option<oneshot::Sender<ClaudeWriteAttempt>>,
}

/// The ordered input queue of one Claude Code process; cloned handles share the queue.
#[derive(Clone)]
pub(crate) struct ClaudeInputWriter {
    lines: mpsc::UnboundedSender<PendingLine>,
    closed: CancellationToken,
}

impl ClaudeInputWriter {
    /// Starts the one task that writes `input`, which it closes once the queue is closed or a
    /// write fails.
    pub(crate) fn start<Input>(input: Input) -> Self
    where
        Input: AsyncWrite + Unpin + Send + 'static,
    {
        let (lines, queued) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        tokio::spawn(write_lines(input, queued, closed.clone()));
        Self { lines, closed }
    }

    /// Queues `bytes`, a whole line, without waiting and keeping no answer; a closed queue drops
    /// it, since nothing would read it.
    pub(crate) fn enqueue_line(&self, bytes: Vec<u8>) {
        let line = PendingLine {
            bytes,
            state: None,
            done: None,
        };
        if self.lines.send(line).is_err() {
            tracing::debug!("a line queued after the Claude Code process's input closed");
        }
    }

    /// Writes `bytes`, a whole line, in its place in the queue, waiting at most `deadline`. A line
    /// still queued at the deadline is taken back and answers `Unsent`; one already being written
    /// answers `Indeterminate`. A caller that stops waiting takes its queued line back too.
    pub(crate) async fn write_line(
        &self,
        bytes: Vec<u8>,
        deadline: Duration,
    ) -> ClaudeWriteAttempt {
        let state = Arc::new(AtomicU8::new(QUEUED));
        let _taken_back_on_drop = TakeBackOnDrop(Arc::clone(&state));
        let (done, answered) = oneshot::channel();
        let line = PendingLine {
            bytes,
            state: Some(Arc::clone(&state)),
            done: Some(done),
        };
        if self.lines.send(line).is_err() {
            return failed(ClaudeWriteDelivery::Unsent, input_closed());
        }
        match tokio::time::timeout(deadline, answered).await {
            Ok(Ok(attempt)) => attempt,
            // The writer ended without answering: only a line it never took is left unanswered.
            Ok(Err(_unanswered)) => failed(delivery_of(&state), input_closed()),
            Err(_elapsed) => failed(
                if take_back(&state) {
                    ClaudeWriteDelivery::Unsent
                } else {
                    ClaudeWriteDelivery::Indeterminate
                },
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the Claude Code process did not take the line in time",
                ),
            ),
        }
    }

    /// Closes the input: the line being written is cut off, every queued line answers `Unsent`,
    /// and the process reads the end of its input.
    pub(crate) fn close(&self) {
        self.closed.cancel();
    }
}

// Takes a caller's line back when its future is dropped while the line still waits.
struct TakeBackOnDrop(Arc<AtomicU8>);

impl Drop for TakeBackOnDrop {
    fn drop(&mut self) {
        take_back(&self.0);
    }
}

// Whether the line was still queued and is now the caller's again.
fn take_back(state: &AtomicU8) -> bool {
    state
        .compare_exchange(QUEUED, ABANDONED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn delivery_of(state: &AtomicU8) -> ClaudeWriteDelivery {
    if state.load(Ordering::Acquire) == WRITING {
        ClaudeWriteDelivery::Indeterminate
    } else {
        ClaudeWriteDelivery::Unsent
    }
}

// Drains the queue in order until it closes, a write fails or the input is closed; every line
// left then answers `Unsent`, and the input is dropped, which closes it.
async fn write_lines<Input>(
    mut input: Input,
    mut queued: mpsc::UnboundedReceiver<PendingLine>,
    closed: CancellationToken,
) where
    Input: AsyncWrite + Unpin,
{
    loop {
        let mut line = tokio::select! {
            biased;
            () = closed.cancelled() => break,
            line = queued.recv() => match line {
                Some(line) => line,
                None => break,
            },
        };
        if let Some(state) = &line.state
            && state
                .compare_exchange(QUEUED, WRITING, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            continue;
        }
        let written = tokio::select! {
            biased;
            () = closed.cancelled() => Err((ClaudeWriteDelivery::Indeterminate, input_closed())),
            written = write_whole_line(&mut input, &line.bytes) => written,
        };
        match written {
            Ok(()) => answer(&mut line, ClaudeWriteAttempt::Written),
            Err((delivery, cause)) => {
                answer(&mut line, failed(delivery, cause));
                break;
            }
        }
    }
    queued.close();
    while let Ok(mut line) = queued.try_recv() {
        answer(
            &mut line,
            failed(ClaudeWriteDelivery::Unsent, input_closed()),
        );
    }
}

// Writes one line counting what the pipe took, never `write_all`, which hides how far a failed
// write got, then flushes it, so a failure the system reports late still lands on this line.
async fn write_whole_line<Input>(
    input: &mut Input,
    bytes: &[u8],
) -> Result<(), (ClaudeWriteDelivery, io::Error)>
where
    Input: AsyncWrite + Unpin,
{
    let mut written = 0;
    while written < bytes.len() {
        match input.write(&bytes[written..]).await {
            Ok(0) => {
                return Err((
                    delivery_after(written),
                    io::Error::from(io::ErrorKind::WriteZero),
                ));
            }
            Ok(taken) => written += taken,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err((delivery_after(written), error)),
        }
    }
    input
        .flush()
        .await
        .map_err(|error| (ClaudeWriteDelivery::Indeterminate, error))
}

fn delivery_after(written: usize) -> ClaudeWriteDelivery {
    if written == 0 {
        ClaudeWriteDelivery::Unsent
    } else {
        ClaudeWriteDelivery::Indeterminate
    }
}

fn answer(line: &mut PendingLine, attempt: ClaudeWriteAttempt) {
    if let Some(done) = line.done.take()
        && done.send(attempt).is_err()
    {
        tracing::debug!("a Claude Code input line was answered after its caller stopped waiting");
    }
}

fn failed(delivery: ClaudeWriteDelivery, cause: io::Error) -> ClaudeWriteAttempt {
    ClaudeWriteAttempt::Failed { delivery, cause }
}

fn input_closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "the Claude Code process's input is closed",
    )
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWrite};

    use super::ClaudeInputWriter;
    use crate::provider::driver::claude::session::transport::user_message::{
        ClaudeWriteAttempt, ClaudeWriteDelivery,
    };

    const DEADLINE: Duration = Duration::from_secs(60);

    fn delivery_of(attempt: &ClaudeWriteAttempt) -> Option<ClaudeWriteDelivery> {
        match attempt {
            ClaudeWriteAttempt::Written => None,
            ClaudeWriteAttempt::Failed { delivery, .. } => Some(*delivery),
        }
    }

    // An input that takes `accepted` bytes in all, then fails every write.
    struct FailingInput {
        accepted: usize,
    }

    impl AsyncWrite for FailingInput {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.accepted == 0 {
                return Poll::Ready(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
            }
            let taken = bytes.len().min(self.accepted);
            self.accepted -= taken;
            Poll::Ready(Ok(taken))
        }

        fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // Killed by answering a deadline the same way whether or not the writer took the line, or by
    // writing a line its caller took back.
    #[tokio::test(start_paused = true)]
    async fn a_queued_line_at_its_deadline_is_unsent_and_never_written() {
        // Room for a few bytes only, and no reader yet, so the first line blocks mid-write.
        let (input, mut output) = tokio::io::duplex(8);
        let writer = ClaudeInputWriter::start(input);
        let blocked = b"first line, longer than the pipe\n".to_vec();
        let queued = b"second line\n".to_vec();

        let (first, second) = tokio::join!(
            writer.write_line(blocked.clone(), DEADLINE),
            writer.write_line(queued, DEADLINE)
        );

        assert_eq!(
            delivery_of(&first),
            Some(ClaudeWriteDelivery::Indeterminate)
        );
        assert_eq!(delivery_of(&second), Some(ClaudeWriteDelivery::Unsent));
        let reading = tokio::spawn(async move {
            let mut read = Vec::new();
            output
                .read_to_end(&mut read)
                .await
                .expect("the test's pipe reads");
            read
        });
        // Lets the first line finish and the writer reach the line taken back before it closes.
        tokio::time::sleep(Duration::from_secs(1)).await;
        writer.close();
        assert_eq!(reading.await.expect("the reader ends"), blocked);
    }

    // Killed by writing from the caller instead of the one writer, which interleaves lines.
    #[tokio::test]
    async fn a_large_line_and_a_short_one_arrive_whole_and_in_order() {
        let (input, mut output) = tokio::io::duplex(4096);
        let writer = ClaudeInputWriter::start(input);
        let mut large = vec![b'a'; 1024 * 1024];
        large.push(b'\n');
        let short = b"short\n".to_vec();
        let reading = tokio::spawn(async move {
            let mut read = Vec::new();
            output
                .read_to_end(&mut read)
                .await
                .expect("the test's pipe reads");
            read
        });

        let (first, second) = tokio::join!(
            writer.write_line(large.clone(), DEADLINE),
            writer.write_line(short.clone(), DEADLINE)
        );
        writer.close();

        assert!(matches!(first, ClaudeWriteAttempt::Written));
        assert!(matches!(second, ClaudeWriteAttempt::Written));
        let mut expected = large;
        expected.extend(short);
        assert_eq!(reading.await.expect("the reader ends"), expected);
    }

    // Killed by `write_all`'s single answer, which cannot tell a failure before the first byte from
    // one after it, or by writing on past a failed line.
    #[tokio::test]
    async fn a_failed_write_answers_by_how_far_its_line_got() {
        let refused = ClaudeInputWriter::start(FailingInput { accepted: 0 });
        let cut = ClaudeInputWriter::start(FailingInput { accepted: 5 });

        let nothing_written = refused.write_line(b"0123456789\n".to_vec(), DEADLINE).await;
        let (cut_short, behind) = tokio::join!(
            cut.write_line(b"0123456789\n".to_vec(), DEADLINE),
            cut.write_line(b"next\n".to_vec(), DEADLINE)
        );

        assert_eq!(
            delivery_of(&nothing_written),
            Some(ClaudeWriteDelivery::Unsent)
        );
        assert_eq!(
            delivery_of(&cut_short),
            Some(ClaudeWriteDelivery::Indeterminate)
        );
        assert_eq!(delivery_of(&behind), Some(ClaudeWriteDelivery::Unsent));
    }
}
