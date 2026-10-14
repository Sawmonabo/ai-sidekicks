//! The frames of a change stream: a change opens a window of `STREAM_WINDOW`, and the changes
//! stored by its close go out as one frame, or at once at the `STREAM_FRAME_MAX_CHANGES`th; a
//! throttle, not a debounce, so no change waits longer than a window. The batcher holds only its
//! cursor: it reads the next frame from the record once the send gate lets it through, so a slow
//! reader holds nothing in memory and loses nothing.

use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::jsonrpc::streaming::STREAM_FRAME_MAX_CHANGES;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

use crate::ipc::stream::feed::{ChangeRecord, SendGate};

/// How long the first change of a frame waits for others before the frame goes out.
pub(crate) const STREAM_WINDOW: Duration = Duration::from_millis(16);

/// One change stream's frames, read from its record at its cursor: never a queue.
pub(crate) struct FrameBatcher<Record: ChangeRecord> {
    /// The stored record the frames are read from.
    record: Arc<Record>,
    /// The position after the last change sent.
    cursor: Record::Cursor,
    /// The record's change signal.
    change_count: watch::Receiver<u64>,
}

impl<Record: ChangeRecord> FrameBatcher<Record> {
    /// A batcher whose first frame starts after `cursor`.
    pub(crate) fn new(record: Arc<Record>, cursor: Record::Cursor) -> Self {
        let change_count = record.change_count();
        Self {
            record,
            cursor,
            change_count,
        }
    }

    /// The next frame's changes, 1 to `STREAM_FRAME_MAX_CHANGES`, oldest first: read once `gate`
    /// resolves, at once when changes wait, else one `STREAM_WINDOW` after the first change
    /// signaled, or at once at the `STREAM_FRAME_MAX_CHANGES`th change signaled. `Ok(None)` once
    /// the gate reports the subscription closed (or the record's signal is gone); a read failure
    /// is the record's error.
    pub(crate) async fn next_frame(
        &mut self,
        gate: &dyn SendGate,
    ) -> Result<Option<Vec<Record::Change>>, Record::Error> {
        loop {
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            // Marked before the read, so a change appended after it is signaled to the wait below.
            let seen = *self.change_count.borrow_and_update();
            let changes = self
                .record
                .read_after(&self.cursor, STREAM_FRAME_MAX_CHANGES)
                .await?;
            if let Some(last) = changes.last() {
                self.cursor = Record::cursor_of(last);
                return Ok(Some(changes));
            }
            if !self.wait_for_window(seen).await {
                return Ok(None);
            }
        }
    }

    /// Waits for the first change signaled after `seen`, then until the window closes or the
    /// `STREAM_FRAME_MAX_CHANGES`th change is signaled; false when the signal was gone before any
    /// change came.
    async fn wait_for_window(&mut self, seen: u64) -> bool {
        if self.change_count.changed().await.is_err() {
            return false;
        }
        let window_end = Instant::now() + STREAM_WINDOW;
        loop {
            let signaled = self.change_count.borrow_and_update().saturating_sub(seen);
            if signaled >= STREAM_FRAME_MAX_CHANGES as u64 {
                return true;
            }
            tokio::select! {
                () = sleep_until(window_end) => return true,
                changed = self.change_count.changed() => {
                    // A signal gone mid-window still lets the stored changes go out.
                    if changed.is_err() {
                        return true;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::Mutex;

    use futures::future::BoxFuture;
    use tokio::sync::Semaphore;

    use super::*;
    use crate::ipc::stream::feed::SubscriptionClosed;

    /// A record of numbered changes, each change its own cursor.
    struct NumberedRecord {
        changes: Mutex<Vec<u64>>,
        count: watch::Sender<u64>,
    }

    impl NumberedRecord {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                changes: Mutex::new(Vec::new()),
                count: watch::Sender::new(0),
            })
        }

        fn append(&self, how_many: u64) {
            for _ in 0..how_many {
                let mut changes = self
                    .changes
                    .lock()
                    .expect("no test thread panics holding it");
                let next = changes.len() as u64 + 1;
                changes.push(next);
                drop(changes);
                self.count.send_modify(|count| *count += 1);
            }
        }
    }

    impl ChangeRecord for NumberedRecord {
        type Cursor = u64;
        type Change = u64;
        type Error = Infallible;

        fn read_after(
            &self,
            cursor: &u64,
            max: usize,
        ) -> BoxFuture<'_, Result<Vec<u64>, Infallible>> {
            let changes = self
                .changes
                .lock()
                .expect("no test thread panics holding it");
            let after = changes
                .iter()
                .copied()
                .filter(|change| change > cursor)
                .take(max)
                .collect();
            Box::pin(std::future::ready(Ok(after)))
        }

        fn cursor_of(change: &u64) -> u64 {
            *change
        }

        fn change_count(&self) -> watch::Receiver<u64> {
            self.count.subscribe()
        }
    }

    /// A gate open while its lane holds credit; this test's frames spend none.
    struct CreditGate {
        credit: Semaphore,
    }

    impl SendGate for CreditGate {
        fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>> {
            Box::pin(async move {
                match self.credit.acquire().await {
                    Ok(_permit) => Ok(()),
                    Err(_closed) => Err(SubscriptionClosed),
                }
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_fiftieth_signaled_change_closes_the_window_at_once() {
        let record = NumberedRecord::new();
        let gate = CreditGate {
            credit: Semaphore::new(1),
        };
        let mut batcher = FrameBatcher::new(Arc::clone(&record), 0);
        let started = Instant::now();
        let (frame, ()) = tokio::join!(batcher.next_frame(&gate), async {
            for _ in 0..STREAM_FRAME_MAX_CHANGES {
                tokio::task::yield_now().await;
                record.append(1);
            }
        });
        let expected: Vec<u64> = (1..=STREAM_FRAME_MAX_CHANGES as u64).collect();
        assert_eq!(frame.expect("the record never fails"), Some(expected));
        assert_eq!(started.elapsed(), Duration::ZERO, "no window passed");
    }

    #[tokio::test(start_paused = true)]
    async fn one_change_leaves_within_one_window() {
        let record = NumberedRecord::new();
        let gate = CreditGate {
            credit: Semaphore::new(1),
        };
        let mut batcher = FrameBatcher::new(Arc::clone(&record), 0);
        let started = Instant::now();
        let (frame, ()) = tokio::join!(batcher.next_frame(&gate), async {
            tokio::task::yield_now().await;
            record.append(1);
        });
        assert_eq!(frame.expect("the record never fails"), Some(vec![1]));
        assert!(
            started.elapsed() <= STREAM_WINDOW,
            "left after {:?}",
            started.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn frames_after_a_stretch_without_credit_carry_every_change_in_order() {
        let record = NumberedRecord::new();
        let gate = Arc::new(CreditGate {
            credit: Semaphore::new(0),
        });
        let mut batcher = FrameBatcher::new(Arc::clone(&record), 0);
        let reader_gate = Arc::clone(&gate);
        let reader = tokio::spawn(async move {
            let mut frames = Vec::new();
            for _ in 0..3 {
                let frame = batcher.next_frame(&*reader_gate).await;
                frames.push(
                    frame
                        .expect("the record never fails")
                        .expect("the gate stays open"),
                );
            }
            frames
        });
        record.append(120);
        tokio::time::sleep(STREAM_WINDOW * 4).await;
        gate.credit.add_permits(1);
        let frames = reader.await.expect("the reader ran");
        assert!(
            frames
                .iter()
                .all(|frame| frame.len() <= STREAM_FRAME_MAX_CHANGES)
        );
        assert_eq!(frames.concat(), (1..=120).collect::<Vec<u64>>());
    }
}
