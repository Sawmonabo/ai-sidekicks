//! The frames of a change stream: the first change signaled after a frame opens a window of
//! `STREAM_WINDOW`, and the changes stored by its close go out as one frame, or at once at the
//! `STREAM_FRAME_MAX_CHANGES`th; a throttle, not a debounce. The batcher sees a change that lands
//! while a frame is written only when it next looks, so that change waits the write plus one
//! window. The batcher holds its cursor and, until it goes out, the first frame it read when it
//! opened, so a stream whose first read fails opens nothing; every later frame it reads from the
//! record once the send gate lets it through, so a slow reader costs no more than the one message
//! its lane has begun, and loses nothing. A read cut short measures how far the record's head
//! stands past the cursor, and a stream over a stored record more than `STREAM_BEHIND_MAX_EVENTS`
//! events or `STREAM_BEHIND_MAX_BYTES` bytes behind it is sent the behind frame in place of the
//! changes and moved to the head. A change feed hands its frames to the subscription.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{
    STREAM_BEHIND_MAX_BYTES, STREAM_BEHIND_MAX_EVENTS, STREAM_FRAME_MAX_CHANGES,
};
use sidekicks_contracts::wire::list::BoundedVec;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

use crate::registry::HandlerError;
use crate::stream::feed::{ChangeRecord, Feed, RecordDistance, RecordPage, SendGate};

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
    first_frame: Option<FrameRead<Record::Change, Record::Head>>,
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

    /// The next frame, read once `gate` resolves: its changes, 1 to `STREAM_FRAME_MAX_CHANGES`,
    /// oldest first, or the head a stream far behind was moved to. It is read at once while
    /// changes are due (stored before the stream began, or left past a full frame), else one
    /// `STREAM_WINDOW` after the first change signaled since the last frame, or at once at the
    /// `STREAM_FRAME_MAX_CHANGES`th. `Ok(None)` once the gate reports the
    /// subscription closed (or the record's signal is gone); a read failure is the record's error.
    /// Dropped before it resolves, it loses no change and the next call resumes an open window.
    pub(crate) async fn next_frame(
        &mut self,
        gate: &dyn SendGate,
    ) -> Result<Option<FrameRead<Record::Change, Record::Head>>, Record::Error> {
        loop {
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            if let Some(frame) = self.first_frame.take() {
                return Ok(Some(frame));
            }
            // A read whose records are all no change, cut short, leaves the next one due at once.
            while self.is_read_due {
                if let Some(frame) = self.read().await? {
                    return Ok(Some(frame));
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
    /// cut short of the record's head, or one holding a full frame, leaves the next one due, unless
    /// the head stands past either far-behind limit: then the page is let go, the cursor moves to
    /// the head and the frame is the head.
    async fn read(
        &mut self,
    ) -> Result<Option<FrameRead<Record::Change, Record::Head>>, Record::Error> {
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
        // Only a read cut short of the head can stand behind more than one frame, so a stream at
        // the head never measures, and a page that reached it is never let go.
        if is_cut_short
            && let Some(head) = read_far_behind_head(&*self.record, &self.cursor).await?
        {
            self.cursor = Record::cursor_at(&head);
            self.is_read_due = false;
            return Ok(Some(FrameRead::Behind(head)));
        }
        self.is_read_due = is_cut_short || changes.len() == STREAM_FRAME_MAX_CHANGES;
        if let Some(read_through) = read_through {
            self.cursor = read_through;
        }
        if changes.is_empty() {
            return Ok(None);
        }
        let changes = BoundedVec::new(changes)
            .expect("a record reads at most the STREAM_FRAME_MAX_CHANGES changes it is asked for");
        Ok(Some(FrameRead::Changes(changes)))
    }

    /// Waits for the first change signaled since the last read began, then until the window it
    /// opens closes or the `STREAM_FRAME_MAX_CHANGES`th change is signaled; false when the signal
    /// was gone before any change came.
    async fn wait_for_window(&mut self) -> bool {
        let window_end = if let Some(window_end) = self.window_end {
            window_end
        } else {
            if self.change_count.changed().await.is_err() {
                return false;
            }
            *self.window_end.insert(Instant::now() + STREAM_WINDOW)
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

/// `record`'s head when `cursor` stands more than `STREAM_BEHIND_MAX_EVENTS` events or
/// `STREAM_BEHIND_MAX_BYTES` bytes behind it, measured over one event past the count limit; `None`
/// when it is nearer, or the record is a current state.
async fn read_far_behind_head<Record: ChangeRecord>(
    record: &Record,
    cursor: &Record::Cursor,
) -> Result<Option<Record::Head>, Record::Error> {
    let distance = record
        .read_distance(cursor, STREAM_BEHIND_MAX_EVENTS + 1)
        .await?;
    Ok(distance
        .filter(|RecordDistance { events, bytes, .. }| {
            *events > STREAM_BEHIND_MAX_EVENTS || *bytes > STREAM_BEHIND_MAX_BYTES
        })
        .map(|distance| distance.head))
}

/// One frame's changes as its stream's contract holds them.
pub type FrameChanges<Change> = BoundedVec<Change, 1, STREAM_FRAME_MAX_CHANGES>;

/// One frame a change stream reads from its record.
#[derive(Debug, PartialEq)]
pub enum FrameRead<Change, Head> {
    /// The changes since the previous frame, oldest first.
    Changes(FrameChanges<Change>),
    /// The head of the stored record the stream stood far behind, which it now reads after.
    Behind(Head),
}

/// A change stream's feed: each frame its batcher reads from the record, made into the stream's
/// frame by `frame_of`. A failed read ends the subscription as a fault in the daemon, and the
/// store closing under the daemon's stop ends it as finished.
pub struct ChangeFeed<Record: ChangeRecord, Frame> {
    /// The frames' batcher.
    batcher: FrameBatcher<Record>,
    /// Makes one frame of its changes.
    frame_of: fn(FrameRead<Record::Change, Record::Head>) -> Frame,
}

impl<Record: ChangeRecord, Frame> ChangeFeed<Record, Frame> {
    /// The feed of `record`'s frames after `cursor`, each made by `frame_of`, its first frame read
    /// at once. Fails as an internal error when that read fails, so the subscribe call is refused
    /// with nothing open.
    pub async fn open(
        record: Arc<Record>,
        cursor: Record::Cursor,
        frame_of: fn(FrameRead<Record::Change, Record::Head>) -> Frame,
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
                Ok(Some(frame)) => Ok(Some((self.frame_of)(frame))),
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
    use crate::stream::feed::{CreditGate, DistanceRead};

    /// The changes of a frame the test expects to carry changes.
    fn changes_of(frame: Option<FrameRead<u64, u64>>) -> Option<Vec<u64>> {
        frame.map(|frame| match frame {
            FrameRead::Changes(changes) => changes.into_vec(),
            FrameRead::Behind(head) => panic!("the stream was moved to {head}"),
        })
    }

    /// A stored record of numbered changes, each change its own cursor and `change_bytes` bytes.
    struct NumberedRecord {
        changes: Mutex<Vec<u64>>,
        count: watch::Sender<u64>,
        change_bytes: usize,
    }

    impl NumberedRecord {
        fn new() -> Arc<Self> {
            Self::with_change_bytes(8)
        }

        fn with_change_bytes(change_bytes: usize) -> Arc<Self> {
            Arc::new(Self {
                changes: Mutex::new(Vec::new()),
                count: watch::Sender::new(0),
                change_bytes,
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
        type Head = u64;

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

        fn read_distance(
            &self,
            cursor: &u64,
            max_events: usize,
        ) -> DistanceRead<'_, u64, Infallible> {
            let changes = self
                .changes
                .lock()
                .expect("no test thread panics holding it");
            let head = changes.last().copied().unwrap_or(*cursor).max(*cursor);
            let events = changes
                .iter()
                .filter(|change| *change > cursor)
                .take(max_events)
                .count();
            Box::pin(std::future::ready(Ok(Some(RecordDistance {
                head,
                events,
                bytes: events * self.change_bytes,
            }))))
        }

        fn cursor_at(head: &u64) -> u64 {
            *head
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
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(expected)
        );
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
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(vec![1])
        );
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
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(vec![2])
        );
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
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(vec![1])
        );
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
                    changes_of(frame.expect("the record never fails"))
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

    // Killed by moving a stream at the limit, by a distance read that never measures, and by a
    // move that leaves the cursor short of the head.
    #[tokio::test(start_paused = true)]
    async fn a_stream_far_behind_is_sent_the_head_and_carries_on_from_it() {
        let record = NumberedRecord::new();
        let gate = CreditGate::with_credit(1);
        let limit = STREAM_BEHIND_MAX_EVENTS as u64;
        record.append(limit);
        let mut at_limit = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
        let frame = at_limit.next_frame(&gate).await;
        let first: Vec<u64> = (1..=STREAM_FRAME_MAX_CHANGES as u64).collect();
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(first),
            "a stream at the limit is sent its changes"
        );

        record.append(1);
        let behind = limit + 1;
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
        let frame = batcher.next_frame(&gate).await;
        assert_eq!(
            frame.expect("the record never fails"),
            Some(FrameRead::Behind(behind)),
            "one frame with no change carries the head"
        );

        record.append(1);
        let frame = batcher.next_frame(&gate).await;
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some(vec![behind + 1]),
            "the next frame reads on from the head"
        );
    }

    // Killed by moving a stream at the byte limit, and by a far-behind check that reads the events
    // alone or needs both limits passed.
    #[tokio::test(start_paused = true)]
    async fn a_stream_behind_by_more_bytes_than_the_limit_is_moved_over_few_events() {
        let gate = CreditGate::with_credit(1);
        let full_frame = STREAM_FRAME_MAX_CHANGES as u64;
        let change_bytes = STREAM_BEHIND_MAX_BYTES / STREAM_FRAME_MAX_CHANGES;
        let record = NumberedRecord::with_change_bytes(change_bytes);
        // One full frame is cut short, so it is measured, and stands exactly at the byte limit.
        record.append(full_frame);
        let mut at_limit = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
        let frame = at_limit.next_frame(&gate).await;
        assert_eq!(
            changes_of(frame.expect("the record never fails")),
            Some((1..=full_frame).collect::<Vec<u64>>()),
            "a stream at the byte limit is sent its changes"
        );

        record.append(1);
        let behind = full_frame + 1;
        let mut batcher = FrameBatcher::open(Arc::clone(&record), 0)
            .await
            .expect("the record never fails");
        let frame = batcher.next_frame(&gate).await;
        assert_eq!(
            frame.expect("the record never fails"),
            Some(FrameRead::Behind(behind))
        );
    }
}
