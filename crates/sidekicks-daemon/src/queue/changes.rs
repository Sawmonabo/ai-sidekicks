//! A queue's changes as its stream reads them: the signal that wakes a reader once a change to
//! the queue commits, the cursor a reader resumes from, and the read of the changes after it. A
//! change an `agent.queueItem.*` event records goes out at that event's cursor; a reorder, which
//! no event records, moves the queue's order mark, and a reader behind the mark reads the waiting
//! items again in their new order, a page at a time, at the session's newest cursor.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use rusqlite::{Connection, named_params};
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemState, RunQueueStreamChange};
use sidekicks_contracts::session::event_cursor::{
    EventCursorPositionOutOfRange, START_OF_LOG_POSITION, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, count_bound};
use tokio::sync::watch;

use crate::database::sql_list::sql_list_of;
use crate::database::stored_column::safe_int_column;
use crate::events::session::read::{
    SessionEventReads, SessionLogReadError, readable_event_sql, session_read_bound,
};
use crate::mutex_lock::lock;
use crate::queue::store::summary::summary_of;
use crate::queue::store::{COLUMN_COUNT, COLUMNS, QUEUE_ORDER, QueueItemRecord, record_of};

/// One queue: the lead's of a session, or a child's by its handle.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct QueueKey {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The child whose queue it is; absent for the lead's.
    pub(crate) child_handle: Option<ChildHandle>,
}

/// Where a queue's stream resumes: the session's event sequence it has read changes through, the
/// order mark it has seen, and, while it sends the waiting items of that mark, the last one sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QueueChangeCursor {
    sequence: i64,
    order_mark: u64,
    waiting_place: Option<WaitingPlace>,
}

impl QueueChangeCursor {
    /// The cursor a subscription catching up after the event `sequence` starts at: behind every
    /// order mark, so its first reads carry each item changed after it and then every item still
    /// waiting, however many wait. A reader resuming after a restart starts here too.
    pub(crate) fn after(sequence: i64) -> Self {
        Self {
            sequence,
            order_mark: BEHIND_EVERY_ORDER_MARK,
            waiting_place: None,
        }
    }
}

/// A waiting item's place in its queue's order, from which the next page of waiting items reads.
#[derive(Clone, Debug, PartialEq, Eq)]
struct WaitingPlace {
    position: SafeInt<0>,
    created_at: WireInstant,
    id: QueueItemId,
}

impl WaitingPlace {
    fn of(record: &QueueItemRecord) -> Self {
        Self {
            position: record.position,
            created_at: record.created_at.clone(),
            id: record.id,
        }
    }
}

/// Where a read of waiting items starts.
#[derive(Clone, Copy, Debug)]
enum WaitingPage<'cursor> {
    /// From the queue's first item, for a reader behind the order mark.
    FromFirst,
    /// After the last item a reader was sent, while its page is unfinished.
    After(&'cursor WaitingPlace),
}

/// One change on a queue's stream with the cursor that resumes after it, which the stream drops
/// when it builds its frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QueueChange {
    /// The change as the stream sends it.
    pub(crate) stream_change: RunQueueStreamChange,
    /// The cursor that resumes after it.
    pub(crate) resume_cursor: QueueChangeCursor,
}

/// Why a read of a queue's changes failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum QueueChangeReadError {
    /// SQLite refused the read, or a stored value does not read as its type.
    #[error("a read of a queue's changes failed")]
    Database(#[from] rusqlite::Error),
    /// The session's newest sequence could not be read.
    #[error(transparent)]
    SessionLog(#[from] SessionLogReadError),
    /// The session's newest sequence is no cursor position, which only a damaged log holds.
    #[error(transparent)]
    NewestCursor(#[from] EventCursorPositionOutOfRange),
}

// The order mark no queue holds: every queue's mark lies past it.
const BEHIND_EVERY_ORDER_MARK: u64 = 0;

/// The change signals of the queues that have a reader: per queue a count raised once per
/// committed change, and an order mark moved by each change no `agent.queueItem.*` event
/// records. A queue no reader follows holds nothing, and a queue's signal is dropped once its last
/// reader goes.
pub(crate) struct QueueChangeSignals {
    table: Mutex<QueueSignalTable>,
}

struct QueueSignalTable {
    // The newest mark any queue was given; marks only grow, so a queue whose signal was dropped
    // and made again never reads behind a cursor's mark.
    newest_order_mark: u64,
    by_queue: HashMap<QueueKey, QueueSignal>,
}

struct QueueSignal {
    count: watch::Sender<u64>,
    order_mark: u64,
}

impl QueueSignalTable {
    // Drops the signal of every queue whose last reader has gone.
    fn drop_unread(&mut self) {
        self.by_queue
            .retain(|_queue, signal| signal.count.receiver_count() > 0);
    }
}

impl QueueChangeSignals {
    /// No queue's signal yet.
    pub(crate) fn new() -> Self {
        Self {
            table: Mutex::new(QueueSignalTable {
                newest_order_mark: BEHIND_EVERY_ORDER_MARK + 1,
                by_queue: HashMap::new(),
            }),
        }
    }

    /// The count of `queue`'s committed changes, held while the receiver lives. A reader takes it
    /// before its starting cursor, so a change between the two is not lost.
    pub(crate) fn change_count(&self, queue: &QueueKey) -> watch::Receiver<u64> {
        let mut guard = self.lock();
        let table = &mut *guard;
        table.drop_unread();
        let newest_order_mark = table.newest_order_mark;
        table
            .by_queue
            .entry(queue.clone())
            .or_insert_with(|| QueueSignal {
                count: watch::Sender::new(0),
                order_mark: newest_order_mark,
            })
            .count
            .subscribe()
    }

    /// Signals one committed change to `queue`, called after its commit; `moves_order` when no
    /// `agent.queueItem.*` event records it (a reorder, or waiting items pointed at a new run),
    /// which moves the queue's order mark before its count. Holds nothing for a queue no reader
    /// follows.
    pub(crate) fn raise_change(&self, queue: &QueueKey, moves_order: bool) {
        let mut guard = self.lock();
        let table = &mut *guard;
        table.drop_unread();
        let Some(signal) = table.by_queue.get_mut(queue) else {
            return;
        };
        if moves_order {
            table.newest_order_mark += 1;
            signal.order_mark = table.newest_order_mark;
        }
        signal.count.send_modify(|count| *count += 1);
    }

    fn order_mark(&self, queue: &QueueKey) -> u64 {
        let table = self.lock();
        table
            .by_queue
            .get(queue)
            .map_or(table.newest_order_mark, |signal| signal.order_mark)
    }

    // No code panics while it holds the table, so a poisoned lock still holds a whole one.
    fn lock(&self) -> MutexGuard<'_, QueueSignalTable> {
        lock(&self.table)
    }
}

static QUEUE_ITEM_EVENT_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    sql_list_of(
        [
            SessionEventType::AgentQueueItemCreated,
            SessionEventType::AgentQueueItemAdmitted,
            SessionEventType::AgentQueueItemSuperseded,
            SessionEventType::AgentQueueItemCanceled,
            SessionEventType::AgentQueueItemNotDelivered,
        ]
        .map(SessionEventType::as_str),
    )
});

// The items a readable `agent.queueItem.*` event changed after a sequence, one row per item at its
// newest such sequence. A row past a damaged session's last good point or in a range it skipped
// may hold a payload that is not JSON, which would fail every read, so none is read.
static CHANGED_ITEMS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(event.payload, '$.queueItemId') AS queue_item_id,
           MAX(event.sequence) AS sequence
      FROM session_events AS event
     WHERE event.session_id = @session_id AND event.sequence > @after
       AND event.type IN ({}) AND {}
     GROUP BY queue_item_id",
        *QUEUE_ITEM_EVENT_TYPES_SQL,
        readable_event_sql("event")
    )
});

// A queue's changed items, oldest change first.
static CHANGED_AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {COLUMNS}, changed.sequence
  FROM ({}) AS changed
  JOIN queue_items ON queue_items.id = changed.queue_item_id
  WHERE queue_items.session_id = @session_id AND queue_items.child_handle IS @child_handle
  ORDER BY changed.sequence
  LIMIT @limit",
        *CHANGED_ITEMS_SQL
    )
});

// A queue's waiting items that no event changed after a sequence: the read sends those at their
// events' cursors. The changed items are grouped once per read, not looked up once per item.
static WAITING_UNCHANGED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {COLUMNS} FROM queue_items
  LEFT JOIN ({}) AS changed ON changed.queue_item_id = queue_items.id
  WHERE queue_items.session_id = @session_id AND queue_items.child_handle IS @child_handle
    AND queue_items.state = '{}' AND changed.queue_item_id IS NULL",
        *CHANGED_ITEMS_SQL,
        <&'static str>::from(QueueItemState::Queued)
    )
});

static WAITING_FROM_FIRST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
  {QUEUE_ORDER}
  LIMIT @limit",
        *WAITING_UNCHANGED_SQL
    )
});

// The waiting items after a place, by the keyset of the queue's order.
static WAITING_AFTER_PLACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
    AND (position > @position OR (position = @position
      AND (created_at < @created_at OR (created_at = @created_at AND id > @id))))
  {QUEUE_ORDER}
  LIMIT @limit",
        *WAITING_UNCHANGED_SQL
    )
});

/// The cursor a subscription without a catch-up cursor starts at, read on `reader`: the session's
/// newest sequence and `queue`'s current order mark, so it follows from now. The reader takes
/// `queue`'s change count first. Fails with [`SessionLogReadError`] when the newest sequence
/// cannot be read.
pub(crate) fn read_current_queue_cursor(
    reader: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    signals: &QueueChangeSignals,
    queue: &QueueKey,
) -> Result<QueueChangeCursor, SessionLogReadError> {
    // Marked before the head, so a reorder between the two is sent rather than lost.
    let order_mark = signals.order_mark(queue);
    let sequence = SessionEventReads::new(reader, read_damaged_from_sequence)
        .read_head(&queue.session_id)?
        .unwrap_or(START_OF_LOG_POSITION);
    Ok(QueueChangeCursor {
        sequence,
        order_mark,
        waiting_place: None,
    })
}

/// At most `max` changes to `queue` after `cursor`, oldest first, read on `reader` in one
/// transaction: each item a readable `agent.queueItem.*` event changed, at that event's cursor;
/// then, once `queue`'s order mark moved past the cursor's, or while a page of waiting items is
/// unfinished, the waiting items in the queue's order at the session's newest cursor. No event
/// past a damaged session's last good point or in a range it skipped is read. Fails with
/// [`QueueChangeReadError`] when SQLite refuses the read or a stored value does not read.
pub(crate) fn read_queue_changes_after(
    reader: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    signals: &QueueChangeSignals,
    queue: &QueueKey,
    cursor: &QueueChangeCursor,
    max: usize,
) -> Result<Vec<QueueChange>, QueueChangeReadError> {
    // Marked before the read, so a reorder committed after it moves the mark past this one.
    let order_mark = signals.order_mark(queue);
    let transaction = reader.unchecked_transaction()?;
    // One answer for the whole read, so the head and every bounded read stop at the same point.
    let damaged_from = read_damaged_from_sequence(&queue.session_id);
    let read_bound = session_read_bound(|_| damaged_from, &queue.session_id, None);
    let head = SessionEventReads::new(reader, |_| damaged_from)
        .read_head(&queue.session_id)?
        .unwrap_or(START_OF_LOG_POSITION);
    let newest_cursor = encode_event_cursor(head)?;
    let mut changes: Vec<QueueChange> = reader
        .prepare_cached(&CHANGED_AFTER_SQL)?
        .query_map(
            named_params! {
                "@session_id": queue.session_id.text().as_str(),
                "@child_handle": queue.child_handle.as_ref().map(ChildHandle::as_str),
                "@after": cursor.sequence,
                "@read_bound": read_bound,
                "@limit": count_bound(max),
            },
            |row| Ok((record_of(row)?, safe_int_column::<0>(row, COLUMN_COUNT)?)),
        )?
        .map(|changed| {
            let (record, sequence) = changed?;
            let sequence = i64::from(sequence);
            Ok(QueueChange {
                stream_change: RunQueueStreamChange {
                    cursor: encode_event_cursor(sequence)
                        .expect("a stored sequence is a safe integer"),
                    item: summary_of(record),
                },
                resume_cursor: QueueChangeCursor {
                    sequence,
                    order_mark: cursor.order_mark,
                    waiting_place: cursor.waiting_place.clone(),
                },
            })
        })
        .collect::<rusqlite::Result<_>>()?;
    let room = max - changes.len();
    let waiting_page = if cursor.order_mark < order_mark {
        Some(WaitingPage::FromFirst)
    } else {
        cursor.waiting_place.as_ref().map(WaitingPage::After)
    };
    if let Some(waiting_page) = waiting_page
        && room > 0
    {
        let waiting = read_waiting_page(
            reader,
            queue,
            cursor.sequence,
            read_bound,
            waiting_page,
            room,
        )?;
        let is_page_finished = waiting.len() < room;
        // Every readable event change after the cursor went out above, so the waiting items
        // resume from the newest readable sequence.
        changes.extend(waiting.into_iter().map(|record| QueueChange {
            resume_cursor: QueueChangeCursor {
                sequence: head,
                order_mark,
                waiting_place: Some(WaitingPlace::of(&record)),
            },
            stream_change: RunQueueStreamChange {
                cursor: newest_cursor.clone(),
                item: summary_of(record),
            },
        }));
        // The pass of this mark is whole, so the reader stands at the mark with no page open.
        if is_page_finished && let Some(last) = changes.last_mut() {
            last.resume_cursor.order_mark = order_mark;
            last.resume_cursor.waiting_place = None;
        }
    }
    transaction.commit()?;
    Ok(changes)
}

// Up to `room` waiting items of `queue` in its order that no readable event changed after
// `after`, from where `waiting_page` starts.
fn read_waiting_page(
    reader: &Connection,
    queue: &QueueKey,
    after: i64,
    read_bound: i64,
    waiting_page: WaitingPage<'_>,
    room: usize,
) -> rusqlite::Result<Vec<QueueItemRecord>> {
    let session_id_text = queue.session_id.text();
    let session_id = session_id_text.as_str();
    let child_handle = queue.child_handle.as_ref().map(ChildHandle::as_str);
    let limit = count_bound(room);
    match waiting_page {
        WaitingPage::FromFirst => reader
            .prepare_cached(&WAITING_FROM_FIRST_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_id,
                    "@child_handle": child_handle,
                    "@after": after,
                    "@read_bound": read_bound,
                    "@limit": limit,
                },
                record_of,
            )?
            .collect(),
        WaitingPage::After(place) => reader
            .prepare_cached(&WAITING_AFTER_PLACE_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_id,
                    "@child_handle": child_handle,
                    "@after": after,
                    "@read_bound": read_bound,
                    "@position": i64::from(place.position),
                    "@created_at": place.created_at.as_str(),
                    "@id": place.id.text().as_str(),
                    "@limit": limit,
                },
                record_of,
            )?
            .collect(),
    }
}
