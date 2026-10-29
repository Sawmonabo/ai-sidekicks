//! The frames of a change stream: the first change signaled after a frame opens a window of
//! `STREAM_WINDOW`, and the changes stored by its close go out as one frame, or at once at the
//! `STREAM_FRAME_MAX_CHANGES`th; a throttle, not a debounce. The batcher sees a change that lands
//! while a frame is written only when it next looks, so that change waits the write plus one
//! window. The batcher holds its cursor and, until it goes out, the first frame it read when it
//! opened, so a stream whose first read fails opens nothing; every later frame it reads from the
//! record once the send gate lets it through, so a slow reader costs no more than the one message
//! its lane has begun, and loses nothing. A change feed hands its frames to the subscription.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::STREAM_FRAME_MAX_CHANGES;
use sidekicks_contracts::wire::list::BoundedVec;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

use crate::registry::HandlerError;
use crate::stream::feed::{ChangeRecord, Feed, RecordPage, SendGate};

/// How long the first change of a frame waits for others before the frame goes out.
pub(crate) const STREAM_WINDOW: Duration = Duration::from_millis(16);

/// One change stream's frames, read from its record at its cursor: never a queue.
pub(crate) struct FrameBatcher<Record: ChangeRecord> {
    /// The stored record the frames are read from.
    record: Arc<Record>,
    /// The position after the last change read.
    cursor: Record::Cursor,
    /// The record's change signal.
    change_count: watch::Receiver<u64>,
    /// The signal's count when the last read began.
    seen: u64,
    /// Whether the next read goes at once: after a full frame, and once a window passed or filled.
    is_read_due: bool,
    /// The first frame, read when the batcher opened, until it goes out.
    first_frame: Option<Vec<Record::Change>>,
    /// When the open window closes, kept so a frame read dropped mid-window resumes it.
    window_end: Option<Instant>,
}

impl<Record: ChangeRecord> FrameBatcher<Record> {
    /// A batcher whose frames start after `cursor`, holding its first frame read at once, so a
    /// stream whose first read fails opens nothing. Fails with the record's error.
    pub(crate) async fn open(
        record: Arc<Record>,
        cursor: Record::Cursor,
    ) -> Result<Self, Record::Error> {
        let change_count = record.change_count();
        let mut batcher = Self {
            record,
            cursor,
            change_count,
            seen: 0,
            is_read_due: true,
            first_frame: None,
            window_end: None,
        };
        batcher.first_frame = batcher.read().await?;
        Ok(batcher)
    }

    /// The next frame's changes, 1 to `STREAM_FRAME_MAX_CHANGES`, oldest first, read once `gate`
    /// resolves: at once while changes are due (stored before the stream began, or left past a
    /// full frame), else one `STREAM_WINDOW` after the first change signaled since the last frame,
    /// or at once at the `STREAM_FRAME_MAX_CHANGES`th. `Ok(None)` once the gate reports the
    /// subscription closed (or the record's signal is gone); a read failure is the record's error.
    /// Dropped before it resolves, it loses no change and the next call resumes an open window.
    pub(crate) async fn next_frame(
        &mut self,
        gate: &dyn SendGate,
    ) -> Result<Option<Vec<Record::Change>>, Record::Error> {
        loop {
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            if let Some(changes) = self.first_frame.take() {
                return Ok(Some(changes));
            }
            // A read whose records are all no change, cut short, leaves the next one due at once.
            while self.is_read_due {
                if let Some(changes) = self.read().await? {
                    return Ok(Some(changes));
                }
            }
            if !self.wait_for_window().await {
                return Ok(None);
            }
            self.window_end = None;
            self.is_read_due = true;
        }
    }

    /// Reads the changes after the cursor and moves the cursor past every record read, a record
    /// that is no change too, so none is read twice; `None` when the read holds no change. A read
    /// cut short by its count or a frame's bytes leaves the next one due.
    async fn read(&mut self) -> Result<Option<Vec<Record::Change>>, Record::Error> {
        // Marked before the read, so a change appended after it is signaled to the wait.
        self.seen = *self.change_count.borrow_and_update();
        let RecordPage {
            changes,
            read_through,
            is_cut_short,
        } = self
            .record
            .read_after(&self.cursor, STREAM_FRAME_MAX_CHANGES)
            .await?;
        self.is_read_due = is_cut_short;
        if let Some(read_through) = read_through {
            self.cursor = read_through;
        }
        Ok((!changes.is_empty()).then_some(changes))
    }

    /// Waits for the first change signaled since the last read began, then until the window it
    /// opens closes or the `STREAM_FRAME_MAX_CHANGES`th change is signaled; false when the signal
    /// was gone before any change came.
    async fn wait_for_window(&mut self) -> bool {
        let window_end = match self.window_end {
            Some(window_end) => window_end,
            None => {
                if self.change_count.changed().await.is_err() {
                    return false;
                }
                *self.window_end.insert(Instant::now() + STREAM_WINDOW)
            }
        };
        loop {
            let signaled = self
                .change_count
                .borrow_and_update()
                .saturating_sub(self.seen);
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

/// One frame's changes as its stream's contract holds them.
pub type FrameChanges<Change> = BoundedVec<Change, 1, STREAM_FRAME_MAX_CHANGES>;

/// A change stream's feed: each frame its batcher reads from the record, made into the stream's
/// frame by `frame_of`. A failed read ends the subscription as a fault in the daemon, and the
/// store closing under the daemon's stop ends it as finished.
pub struct ChangeFeed<Record: ChangeRecord, Frame> {
    /// The frames' batcher.
    batcher: FrameBatcher<Record>,
    /// Makes one frame of its changes.
    frame_of: fn(FrameChanges<Record::Change>) -> Frame,
}

impl<Record: ChangeRecord, Frame> ChangeFeed<Record, Frame> {
    /// The feed of `record`'s frames after `cursor`, each made by `frame_of`, its first frame read
    /// at once. Fails as an internal error when that read fails, so the subscribe call is refused
    /// with nothing open.
    pub async fn open(
        record: Arc<Record>,
        cursor: Record::Cursor,
        frame_of: fn(FrameChanges<Record::Change>) -> Frame,
    ) -> Result<Self, HandlerError> {
        let batcher = FrameBatcher::open(record, cursor)
            .await
            .map_err(|error| HandlerError::Internal(Box::new(error)))?;
        Ok(Self { batcher, frame_of })
    }
}

impl<Record: ChangeRecord, Frame: Send> Feed for ChangeFeed<Record, Frame> {
    type Emission = Frame;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<Frame>, HandlerError>> {
        async move {
            match self.batcher.next_frame(gate).await {
                Ok(Some(changes)) => Ok(Some((self.frame_of)(
                    BoundedVec::new(changes)
                        .expect("a frame holds one to STREAM_FRAME_MAX_CHANGES changes"),
                ))),
                Ok(None) => Ok(None),
                Err(error) if Record::is_store_closed(&error) => Ok(None),
                Err(error) => Err(HandlerError::Internal(Box::new(error))),
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::Mutex;

    use futures::future::BoxFuture;

    use super::*;
    use crate::stream::feed::CreditGate;

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
        ) -> BoxFuture<'_, Result<RecordPage<u64, u64>, Infallible>> {
            let changes = self
                .changes
                .lock()
                .expect("no test thread panics holding it");
            let after: Vec<u64> = changes
                .iter()
                .copied()
                .filter(|change| change > cursor)
                .take(max)
                .collect();
            Box::pin(std::future::ready(Ok(RecordPage {
                read_through: after.last().copied(),
                is_cut_short: after.len() == max,
                changes: after,
            })))
        }

        fn change_count(&self) -> watch::Receiver<u64> {
            self.count.subscribe()
        }

        fn is_store_closed(error: &Infallible) -> bool {
            match *error {}
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_fiftieth_signaled_change_closes_the_window_at_once() {
        let record = NumberedRecord::new();
        let gate = CreditGate::with_credit(1);
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
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
        let gate = CreditGate::with_credit(1);
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
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

        // A change that lands while that frame is written waits one window of its own, so it is
        // batched with the changes after it rather than sent alone.
        record.append(1);
        let started = Instant::now();
        let frame = batcher.next_frame(&gate).await;
        assert_eq!(frame.expect("the record never fails"), Some(vec![2]));
        assert_eq!(started.elapsed(), STREAM_WINDOW, "it waited one window");
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_dropped_mid_window_is_resumed_by_the_next_and_loses_no_change() {
        let record = NumberedRecord::new();
        let gate = CreditGate::with_credit(1);
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
        record.append(1);
        let started = Instant::now();
        let dropped = tokio::time::timeout(STREAM_WINDOW / 2, batcher.next_frame(&gate)).await;
        assert!(
            dropped.is_err(),
            "the window was still open when the read was dropped"
        );
        let frame = tokio::time::timeout(STREAM_WINDOW * 4, batcher.next_frame(&gate))
            .await
            .expect("the change already signaled goes out without another");
        assert_eq!(frame.expect("the record never fails"), Some(vec![1]));
        assert_eq!(
            started.elapsed(),
            STREAM_WINDOW,
            "the open window was resumed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn frames_after_a_stretch_without_credit_carry_every_change_in_order() {
        let record = NumberedRecord::new();
        let gate = Arc::new(CreditGate::with_credit(0));
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
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
