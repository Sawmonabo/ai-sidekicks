//! The event log service: the only append path for `session_events`, and the log's reads.
//!
//! - Order: the database writer reads the session's head and writes the row in one step on its
//!   own connection, so two appends never share a sequence. An append holds the session's append
//!   lock only while its write joins the writer's queue, so a caller holding the session sees its
//!   rows land in the order it appended them, and lets it go before the commit, so a session's
//!   appends share batches. A caller already holding the session appends with its hold. A read
//!   that decides a write goes inside that write as a guarded statement in the transactional
//!   prelude.
//! - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//!   gains the members that describe it; both are written as a unit.
//! - Dual-write: the transactional prelude is committed in the same write just before the rows,
//!   then each row's projection statements. A guarded statement carries the row count it expects,
//!   so a moved state refuses the write and consumes no sequence.
//! - Refusal: a session that takes no writes, and an event that would not store faithfully, are
//!   refused before anything is queued.
//! - One copy: each event is held once, shared by the row the writer binds and the commit hook,
//!   beside its payload text, serialized on the appending task.
//! - Publication: each committed write's events go to the followers from the writer's commit hook,
//!   on the writer's queue task, in commit order, whether or not the append's caller still waits.
//! - Reads: each borrows a connection from the daemon's read pool on a blocking thread.

use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, EventCursorPositionOutOfRange, START_OF_LOG_POSITION,
    SessionEventCursorUnresolvable, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::watch;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::WriteStatement;
use crate::database::writer::messages::WriteJob;
use crate::database::writer::{CommitHook, DatabaseWriter, PendingWrite, WriteError};
use crate::events::canonicalizer::{OccurredAtNormalizationRefusal, normalize_occurred_at};
use crate::events::content::append::{
    ContentDescriptionSeededError, ContentPartitionRefusedError, PatchFilesRefusedError,
    assert_no_seeded_content_description,
};
use crate::events::session::append_lock::{SESSION_APPEND_LOCK, SessionAppendHold};
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::events::session::followers::{CommittedEvent, SessionEventFollowers};
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::events::session::read::{
    DamagedFromSequenceReader, SessionEventFilter, SessionEventReads, SessionLogReadError,
    resolve_event_cursor,
};
use crate::ipc::domain_error::DomainError;

/// The most events a read after a cursor returns when the caller names no limit.
const DEFAULT_EVENT_READ_LIMIT: u32 = 100;

/// The distinct statements run on the service's read connections: the head, the rows after a
/// position, those rows of chosen types, and a window of rows; and the three turn attribution
/// reads a session's event stream runs on the same connection, the rollbacks before a position,
/// the turns between two, and a tool call's opening.
pub(crate) const EVENT_LOG_STATEMENT_CAPACITY: usize = 7;

/// How the append path names itself in a refusal.
const APPEND_REFUSER: &str = "EventLogService::append";

/// Statements that keep a projection in step with the log, given each event as it will be stored.
pub(crate) type ProjectionStatements =
    dyn Fn(&UnsequencedEventEnvelope) -> Vec<WriteStatement> + Send + Sync;

/// Refuses an append to a session that takes no event of the given type, with the refusal the
/// caller answers.
pub(crate) type SessionWriteCheck =
    dyn Fn(&SessionId, &str) -> Result<(), DomainError> + Send + Sync;

/// The reads of one call, on a borrowed connection.
type LogReads<'reader> = SessionEventReads<'reader, &'reader DamagedFromSequenceReader>;

/// How one [`EventLogService::append`] is written.
#[derive(Debug, Default)]
pub(crate) struct EventLogAppendOptions {
    /// The event's machine-authored prose, kept in `content_payload`; only a body-bearing type
    /// takes one, and a body over the bound is cut at a character boundary.
    pub(crate) content_body: Option<String>,
    /// Statements committed in the same write just before the rows. One whose row count is not
    /// the one it expects refuses the write, and nothing of it is kept.
    pub(crate) transactional_prelude: Vec<WriteStatement>,
    /// Events of the same session committed in the same write, in order, just before this one,
    /// each at its own sequence with its body, if any; each is checked as this one is.
    pub(crate) preceding_events: Vec<(UnsequencedEventEnvelope, Option<String>)>,
}

/// An appended event once it committed: its id and the sequence the writer gave it.
#[derive(Clone, Debug)]
pub(crate) struct EventLogAppendReceipt {
    /// The event's id, as given.
    pub(crate) id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The event's sequence in its session's log.
    pub(crate) sequence: SafeInt<0>,
}

/// Why an append was not kept; none of its events is stored.
#[derive(Debug, thiserror::Error)]
pub(crate) enum EventAppendError {
    /// The session takes no event of this type; the refusal is the one its check built.
    #[error(transparent)]
    SessionWriteRefused(DomainError),
    /// A preceding event names another session than the event it precedes.
    #[error(
        "a preceding {preceding_type} event of session {} cannot share the write of an event of \
         session {}",
        .preceding_session_id,
        .session_id
    )]
    PrecedingEventOfAnotherSession {
        /// The preceding event's type.
        preceding_type: String,
        /// The preceding event's session.
        preceding_session_id: SessionId,
        /// The appended event's session.
        session_id: SessionId,
    },
    /// The append was given a hold on another session than the event's.
    #[error(
        "an event of session {} cannot be appended under a hold on session {}",
        .session_id,
        .held_session_id
    )]
    HoldOfAnotherSession {
        /// The session the hold is on.
        held_session_id: SessionId,
        /// The event's session.
        session_id: SessionId,
    },
    /// The payload already carries a content description member, which only the append path sets.
    #[error(transparent)]
    SeededContentDescription(#[from] ContentDescriptionSeededError),
    /// The event's `occurredAt` cannot take the stored form.
    #[error("the event's occurredAt cannot be stored")]
    OccurredAt(#[from] OccurredAtNormalizationRefusal),
    /// A content body was given for a type that carries none.
    #[error(transparent)]
    ContentPartition(#[from] ContentPartitionRefusedError),
    /// A tool completion naming patched files carries a body that is not their list.
    #[error(transparent)]
    PatchFiles(#[from] PatchFilesRefusedError),
    /// The writer did not keep the write: a guarded statement refused it
    /// ([`WriteError::Refused`]), SQLite failed it, or the writer was ended or closed.
    #[error("the event's write was not kept")]
    Write(#[from] WriteError),
}

/// Why a read of the log failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum EventLogReadError {
    /// The cursor names no position, or one past the session's last event.
    #[error(transparent)]
    CursorUnresolvable(#[from] SessionEventCursorUnresolvable),
    /// SQLite refused the read, or a stored row is not a well-formed event.
    #[error("the session's event log could not be read")]
    Read(#[from] SessionLogReadError),
    /// A stored position has no cursor, being past the safe integers.
    #[error("a read position has no event cursor")]
    CursorOutOfRange(#[from] EventCursorPositionOutOfRange),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl EventLogReadError {
    /// Whether the read failed because the read pool is closed, as it is at the daemon's stop.
    pub(crate) fn is_pool_closed(&self) -> bool {
        match self {
            Self::Pool(DatabaseReadError::Closed) => true,
            Self::Pool(DatabaseReadError::Open(_) | DatabaseReadError::Join(_))
            | Self::CursorUnresolvable(_)
            | Self::Read(_)
            | Self::CursorOutOfRange(_) => false,
        }
    }
}

/// Where a follow of a session's log starts.
#[derive(Clone, Debug)]
pub(crate) enum FollowStart {
    /// Before the session's first event.
    StartOfLog,
    /// After the session's newest readable event.
    Newest,
    /// After the event this cursor names.
    After(EventCursor),
}

/// Why a follow of a session's log could not start.
#[derive(Debug, thiserror::Error)]
pub(crate) enum EventLogFollowError {
    /// The session has no events and no damaged history, so the daemon holds no such session.
    #[error("session {0} has no events to follow")]
    SessionNotFound(SessionId),
    /// The cursor could not be resolved, or the read failed.
    #[error(transparent)]
    Read(#[from] EventLogReadError),
}

impl From<DatabaseReadError> for EventLogFollowError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(error.into())
    }
}

/// One page a change stream reads of a session's log: the session's head when the page's read
/// began, then the events after the page's position.
pub(crate) struct EventStreamPage {
    /// The session's newest readable sequence, read before the events, `None` when it has none.
    pub(crate) head: Option<i64>,
    /// The events after the position, of the page's types, in sequence order.
    pub(crate) events: Vec<EventEnvelope>,
}

/// What [`EventLogService::read_after_cursor`] reads.
#[derive(Clone, Debug)]
pub(crate) struct EventReadAfterCursorRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The position to read after; `None` reads from the start of the log.
    pub(crate) after_cursor: Option<EventCursor>,
    /// The most events returned; 100 when `None`.
    pub(crate) limit: Option<u32>,
}

/// What [`EventLogService::read_after_cursor`] returns.
#[derive(Clone, Debug)]
pub(crate) struct EventReadAfterCursorResponse {
    /// The events after the cursor, in sequence order.
    pub(crate) events: Vec<EventEnvelope>,
    /// Resumes right after the last event returned; when none was, the position read after.
    pub(crate) next_cursor: EventCursor,
    /// Whether the limit left events beyond `next_cursor`.
    pub(crate) has_more: bool,
}

/// What [`EventLogService::read_window`] reads: both sequences are included.
#[derive(Clone, Debug)]
pub(crate) struct EventReadWindowRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The first sequence read.
    pub(crate) from_sequence: i64,
    /// The last sequence read.
    pub(crate) to_sequence: i64,
}

/// What [`EventLogService::read_window`] returns.
#[derive(Clone, Debug)]
pub(crate) struct EventReadWindowResponse {
    /// The window's events, in sequence order.
    pub(crate) events: Vec<EventEnvelope>,
}

/// What the event log service is built from.
pub(crate) struct EventLogServiceDependencies {
    /// The writer every append goes through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The read pool every read borrows a connection from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The followers the daemon's start shares with every consumer; each committed write's events
    /// are published to them.
    pub(crate) followers: Arc<SessionEventFollowers>,
    /// Statements committed in each append's write after its prelude, per event; none when absent.
    pub(crate) projection_statements: Option<Box<ProjectionStatements>>,
    /// Refuses an append to a session that takes no event of its type; every append is taken when
    /// absent.
    pub(crate) refuse_session_write: Option<Box<SessionWriteCheck>>,
    /// Where a damaged session's reads stop; every session reads whole when absent.
    pub(crate) read_damaged_from_sequence: Option<Arc<DamagedFromSequenceReader>>,
}

/// The sole append path for `session_events` and the log's reads; see the module doc.
pub(crate) struct EventLogService {
    writer: Arc<DatabaseWriter>,
    pool: Arc<DatabaseReadPool>,
    followers: Arc<SessionEventFollowers>,
    projection_statements: Option<Box<ProjectionStatements>>,
    refuse_session_write: Option<Box<SessionWriteCheck>>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// One append's write, composed and checked, ready to queue.
struct ComposedWrite {
    job: WriteJob,
    on_commit: CommitHook,
    id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where the event's own row sits among the write's rows.
    row_index: usize,
}

impl EventLogService {
    /// The service over `dependencies`.
    pub(crate) fn new(dependencies: EventLogServiceDependencies) -> Self {
        let EventLogServiceDependencies {
            writer,
            pool,
            followers,
            projection_statements,
            refuse_session_write,
            read_damaged_from_sequence,
        } = dependencies;
        let read_damaged_from_sequence = read_damaged_from_sequence.unwrap_or_else(|| {
            let reads_whole: Arc<DamagedFromSequenceReader> = Arc::new(|_: &SessionId| None::<i64>);
            reads_whole
        });
        Self {
            writer,
            pool,
            followers,
            projection_statements,
            refuse_session_write,
            read_damaged_from_sequence,
        }
    }

    /// Appends `envelope`, after any preceding events, holding its session's append lock while
    /// the write is queued, and returns once it committed, with its sequence. Refuses, before
    /// anything is queued, an event of a session that takes no writes, a preceding event of
    /// another session, a seeded content description, a content body on a type that carries none
    /// and an `occurredAt` that cannot be stored; then fails as the writer does,
    /// [`WriteError::Refused`] among it. An event is never refused for its size. Dropping the
    /// future once its write is queued neither withdraws the write nor its publication.
    pub(crate) async fn append(
        &self,
        envelope: UnsequencedEventEnvelope,
        options: EventLogAppendOptions,
    ) -> Result<EventLogAppendReceipt, EventAppendError> {
        let session_id = envelope.session_id();
        let write = self.compose_write(envelope, options)?;
        let hold = SESSION_APPEND_LOCK.acquire(session_id).await;
        let queued = self.enqueue(write);
        // Let go once queued, so the commit is awaited outside the lock.
        drop(hold);
        committed(queued?).await
    }

    /// Appends as [`EventLogService::append`] does, under `hold`, the caller's own hold on the
    /// event's session, so it never waits on that lock. Also refuses a hold on another session.
    pub(crate) async fn append_held(
        &self,
        hold: &SessionAppendHold,
        envelope: UnsequencedEventEnvelope,
        options: EventLogAppendOptions,
    ) -> Result<EventLogAppendReceipt, EventAppendError> {
        if *hold.key() != envelope.session_id() {
            return Err(EventAppendError::HoldOfAnotherSession {
                held_session_id: *hold.key(),
                session_id: envelope.session_id(),
            });
        }
        let write = self.compose_write(envelope, options)?;
        committed(self.enqueue(write)?).await
    }

    /// Up to `limit` events after the cursor's position, in sequence order. The session's head is
    /// read first and the cursor checked against it. Fails with
    /// [`EventLogReadError::CursorUnresolvable`] for a cursor that names no position or one past
    /// the session's last event, and as the read fails.
    pub(crate) async fn read_after_cursor(
        &self,
        request: EventReadAfterCursorRequest,
    ) -> Result<EventReadAfterCursorResponse, EventLogReadError> {
        self.read(ReadLength::Long, move |reads, _, _| {
            let EventReadAfterCursorRequest {
                session_id,
                after_cursor,
                limit,
            } = request;
            let after_position =
                resolve_event_cursor(after_cursor.as_ref(), reads.read_head(&session_id)?)?;
            let limit = limit.unwrap_or(DEFAULT_EVENT_READ_LIMIT);
            // One row past the limit shows whether more remain.
            let mut events = reads.read_after(
                &session_id,
                after_position,
                i64::from(limit) + 1,
                SessionEventFilter::default(),
            )?;
            let kept = usize::try_from(limit).unwrap_or(usize::MAX);
            let has_more = events.len() > kept;
            events.truncate(kept);
            let next_position = events
                .last()
                .map_or(after_position, |event| i64::from(event.sequence));
            Ok(EventReadAfterCursorResponse {
                events,
                next_cursor: encode_event_cursor(next_position)?,
                has_more,
            })
        })
        .await
    }

    /// The cursor of the session's newest readable event, below its last good point while its
    /// history is damaged, or the start of its log when it has none. Fails as the read fails.
    pub(crate) async fn read_newest_cursor(
        &self,
        session_id: SessionId,
    ) -> Result<EventCursor, EventLogReadError> {
        self.read(ReadLength::Short, move |reads, _, _| {
            let head = reads.read_head(&session_id)?;
            Ok(encode_event_cursor(head.unwrap_or(START_OF_LOG_POSITION))?)
        })
        .await
    }

    /// The position a follow of `session_id` starts after, as a cursor: the start of its log, its
    /// newest readable event, or the event `start` names, checked against its head. Fails with
    /// [`EventLogFollowError::SessionNotFound`] for a session with no events and no damaged
    /// history, with [`EventLogReadError::CursorUnresolvable`] for a cursor that names no position
    /// or one past the head, and as the read fails.
    pub(crate) async fn read_follow_start(
        &self,
        session_id: SessionId,
        start: FollowStart,
    ) -> Result<EventCursor, EventLogFollowError> {
        self.read(
            ReadLength::Short,
            move |reads, _, read_damaged_from_sequence| {
                let head = reads
                    .read_head(&session_id)
                    .map_err(EventLogReadError::from)?;
                if head.is_none() && read_damaged_from_sequence(&session_id).is_none() {
                    return Err(EventLogFollowError::SessionNotFound(session_id));
                }
                let position = match start {
                    FollowStart::StartOfLog => START_OF_LOG_POSITION,
                    FollowStart::Newest => head.unwrap_or(START_OF_LOG_POSITION),
                    FollowStart::After(cursor) => resolve_event_cursor(Some(&cursor), head)
                        .map_err(EventLogReadError::from)?,
                };
                Ok(encode_event_cursor(position).map_err(EventLogReadError::from)?)
            },
        )
        .await
    }

    /// Reads one page of a change stream over `session_id`'s log: its head, then at most `max`
    /// events after `after_position`, only of `event_types` when given, and answers what
    /// `changes_of` makes of them on the same connection, which may read more of the log. Fails
    /// with `changes_of`'s failure, and as the read fails.
    pub(crate) async fn read_stream_page<Changes, Failure>(
        &self,
        session_id: SessionId,
        after_position: i64,
        max: usize,
        event_types: Option<&'static [&'static str]>,
        changes_of: impl FnOnce(
            &Connection,
            &DamagedFromSequenceReader,
            EventStreamPage,
        ) -> Result<Changes, Failure>
        + Send
        + 'static,
    ) -> Result<Changes, Failure>
    where
        Changes: Send + 'static,
        Failure: From<EventLogReadError> + From<DatabaseReadError> + Send + 'static,
    {
        self.read(
            ReadLength::Long,
            move |reads, connection, read_damaged_from_sequence| {
                let head = reads
                    .read_head(&session_id)
                    .map_err(EventLogReadError::from)?;
                let events = reads
                    .read_after(
                        &session_id,
                        after_position,
                        i64::try_from(max).unwrap_or(i64::MAX),
                        SessionEventFilter {
                            event_types,
                            before_sequence: None,
                        },
                    )
                    .map_err(EventLogReadError::from)?;
                changes_of(
                    connection,
                    read_damaged_from_sequence,
                    EventStreamPage { head, events },
                )
            },
        )
        .await
    }

    /// The change count of `session_id`'s log, which a change stream over it waits on: it grows by
    /// one per event committed once that event can be read.
    pub(crate) fn change_count(&self, session_id: &SessionId) -> watch::Receiver<u64> {
        self.followers.change_count(session_id)
    }

    /// The events with a sequence from the request's first to its last, in sequence order. Fails
    /// as the read fails.
    pub(crate) async fn read_window(
        &self,
        request: EventReadWindowRequest,
    ) -> Result<EventReadWindowResponse, EventLogReadError> {
        self.read(ReadLength::Long, move |reads, _, _| {
            let events = reads.read_window(
                &request.session_id,
                request.from_sequence,
                request.to_sequence,
            )?;
            Ok(EventReadWindowResponse { events })
        })
        .await
    }

    /// Whether this log appends through `writer`. A row written with an event commits in the
    /// event's own write only when both go through one writer, so a service relying on that
    /// checks it.
    pub(crate) fn writes_through(&self, writer: &Arc<DatabaseWriter>) -> bool {
        Arc::ptr_eq(&self.writer, writer)
    }

    /// Runs `read` on a borrowed connection on a blocking thread, handing it the log's reads on it,
    /// the connection itself and where a damaged session's reads stop.
    async fn read<Output, Failure>(
        &self,
        length: ReadLength,
        read: impl FnOnce(
            &LogReads<'_>,
            &Connection,
            &DamagedFromSequenceReader,
        ) -> Result<Output, Failure>
        + Send
        + 'static,
    ) -> Result<Output, Failure>
    where
        Output: Send + 'static,
        Failure: From<DatabaseReadError> + Send + 'static,
    {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(length, move |connection| {
                read(
                    &SessionEventReads::new(connection, &*read_damaged_from_sequence),
                    connection,
                    &*read_damaged_from_sequence,
                )
            })
            .await
    }

    /// Composes every event of one append as it will be stored and the write that stores them.
    /// Refuses as [`EventLogService::append`] says, before anything is queued.
    fn compose_write(
        &self,
        envelope: UnsequencedEventEnvelope,
        options: EventLogAppendOptions,
    ) -> Result<ComposedWrite, EventAppendError> {
        if let Some(refuse_session_write) = &self.refuse_session_write {
            refuse_session_write(&envelope.session_id(), envelope.event_type().as_str())
                .map_err(EventAppendError::SessionWriteRefused)?;
        }
        let EventLogAppendOptions {
            content_body,
            transactional_prelude,
            preceding_events,
        } = options;
        // One clock reading for every event of the write.
        let monotonic_ns = monotonic_ns_now();
        let mut rows = Vec::with_capacity(preceding_events.len() + 1);
        for (preceding, preceding_body) in preceding_events {
            if preceding.session_id() != envelope.session_id() {
                return Err(EventAppendError::PrecedingEventOfAnotherSession {
                    preceding_type: preceding.event_type().as_str().to_owned(),
                    preceding_session_id: preceding.session_id(),
                    session_id: envelope.session_id(),
                });
            }
            rows.extend(compose_rows(
                preceding,
                preceding_body.as_deref(),
                monotonic_ns,
            )?);
        }
        // The event's receipt names its own row, which any rows of its files follow.
        let row_index = rows.len();
        let event_rows = compose_rows(envelope, content_body.as_deref(), monotonic_ns)?;
        let id = event_rows[0].envelope.id.clone();
        rows.extend(event_rows);

        let mut statements = transactional_prelude;
        if let Some(projection_statements) = &self.projection_statements {
            for row in &rows {
                statements.extend(projection_statements(&row.envelope));
            }
        }
        let stored_envelopes = rows.iter().map(|row| Arc::clone(&row.envelope)).collect();
        Ok(ComposedWrite {
            job: WriteJob {
                statements,
                events: rows,
            },
            on_commit: publish_on_commit(stored_envelopes, Arc::clone(&self.followers)),
            id,
            row_index,
        })
    }

    /// Queues `write` with no await, so a caller holding the session's lock lets it go at once.
    fn enqueue(&self, write: ComposedWrite) -> Result<QueuedAppend, WriteError> {
        let pending = self.writer.enqueue(write.job, Some(write.on_commit))?;
        Ok(QueuedAppend {
            pending,
            id: write.id,
            row_index: write.row_index,
        })
    }
}

/// An append's write once queued, with the event's id and where its row sits among the write's.
struct QueuedAppend {
    pending: PendingWrite,
    id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    row_index: usize,
}

/// The receipt of a queued append once its write committed.
async fn committed(queued: QueuedAppend) -> Result<EventLogAppendReceipt, EventAppendError> {
    let committed = queued.pending.await?;
    let sequence = *committed
        .sequences
        .get(queued.row_index)
        .expect("a committed write has a sequence per row, the event's among them");
    Ok(EventLogAppendReceipt {
        id: queued.id,
        sequence,
    })
}

/// The commit hook that pairs `stored_envelopes`, the ones the write's rows bound, with the
/// sequences their write committed at and publishes them to `followers` once, on the writer's
/// queue task.
fn publish_on_commit(
    stored_envelopes: Vec<Arc<UnsequencedEventEnvelope>>,
    followers: Arc<SessionEventFollowers>,
) -> CommitHook {
    Box::new(move |sequences: &[SafeInt<0>]| {
        let committed: Vec<CommittedEvent> = stored_envelopes
            .into_iter()
            .zip(sequences.iter().copied())
            .map(|(envelope, sequence)| CommittedEvent { envelope, sequence })
            .collect();
        followers.publish(&committed);
    })
}

/// Composes the rows of one event exactly as they will be stored: the envelope in its stored form,
/// shared by the row and the commit hook, its payload text and its body, then, for a tool
/// completion naming the files its body's patches cover, one row per file, which joins the event's
/// row. Everything bound comes from the composed envelope, never the caller's input.
pub(crate) fn compose_rows(
    mut envelope: UnsequencedEventEnvelope,
    content_body: Option<&str>,
    monotonic_ns: i64,
) -> Result<Vec<SessionEventRow>, EventAppendError> {
    // Checked before the content picks the branch: a seeded `contentLength` without content would
    // otherwise be stored as given.
    assert_no_seeded_content_description(envelope.payload(), APPEND_REFUSER)?;
    envelope.occurred_at = normalize_occurred_at(envelope.occurred_at.as_str())?;
    let (content_payload, files) = match content_body {
        None => (None, Vec::new()),
        Some(body) if envelope.is_patch_bearing() => {
            let (opening, files) = envelope.describe_patch_files(body)?;
            (Some(opening), files)
        }
        Some(body) => (Some(envelope.describe_content(body)?), Vec::new()),
    };
    let row = |envelope: UnsequencedEventEnvelope, content_payload| SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns,
        content_payload,
    };
    let mut rows = Vec::with_capacity(1 + files.len());
    rows.push(row(envelope, content_payload));
    rows.extend(
        files
            .into_iter()
            .map(|(file, content_payload)| row(file, Some(content_payload))),
    );
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests;
