//! The event log service: the only append path for `session_events`, and the log's reads.
//!
//! - Order: the database writer reads the session's head and writes the row in one step on its
//!   own connection, so two appends never share a sequence. An append takes the session's append
//!   lock only while its write joins the writer's queue, so a caller holding the session sees its
//!   rows land in the order it appended them, and lets it go before the commit, so a session's
//!   appends share batches. A read that decides a write goes inside that write as a guarded
//!   statement in the transactional prelude.
//! - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//!   gains the members that describe it; both are written as a unit.
//! - Dual-write: the transactional prelude is committed in the same write just before the rows,
//!   then each row's projection statements. A guarded statement carries the row count it expects,
//!   so a moved state refuses the write and consumes no sequence.
//! - Refusal: a session that takes no writes, and an event that would not store faithfully, are
//!   refused before anything is queued.
//! - Publication: each committed write's events go to the followers from the writer's commit hook,
//!   on the writer's queue task, in commit order, whether or not the append's caller still waits.
//! - Reads: one read-only connection of the service's own, read on a blocking thread and closed
//!   through [`EventLogService::close`].

use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::{
    EventCategory, EventEnvelope, EventEnvelopeType, EventOccurredAt,
};
use sidekicks_contracts::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use sidekicks_contracts::session::event_cursor::{
    EventCursor, EventCursorPositionOutOfRange, EventCursorUnresolvable, START_OF_LOG_POSITION,
    encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::reader::{
    DatabaseReader, DatabaseReaderCloseError, DatabaseReaderError,
};
use crate::database::statement::WriteStatement;
use crate::database::writer::messages::WriteJob;
use crate::database::writer::{CommitHook, DatabaseWriter, WriteError, WriteOptions};
use crate::events::canonicalizer::{
    CanonicalizationRefusal, OccurredAtNormalizationRefusal, canonicalize_event,
    normalize_occurred_at,
};
use crate::events::content::append::{
    ContentDescriptionSeededError, ContentPartitionRefusedError, RegisteredVariantRefusal,
    assert_no_seeded_content_description, assert_registered_variant_parses, compose_content_row,
};
use crate::events::session::append_lock::SESSION_APPEND_LOCK;
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::events::session::read::{
    DamagedFromSequenceReader, SessionEventFilter, SessionEventReads, SessionLogReadError,
    resolve_event_cursor,
};
use crate::ipc::domain_error::DomainError;

/// The most events a read after a cursor returns when the caller names no limit.
const DEFAULT_EVENT_READ_LIMIT: u32 = 100;

/// The distinct statements the service's reads run on its connection: the head, the rows after a
/// position, and a window of rows.
const READER_STATEMENT_CAPACITY: usize = 3;

/// How the append path names itself in a refusal.
const APPEND_REFUSER: &str = "EventLogService::append";

/// Statements that keep a projection in step with the log, given each event as it will be stored.
pub(crate) type ProjectionStatements =
    dyn Fn(&UnsequencedEventEnvelope) -> Vec<WriteStatement> + Send + Sync;

/// Refuses an append to a session that takes no event of the given type, with the refusal the
/// caller answers.
pub(crate) type SessionWriteCheck =
    dyn Fn(&SessionId, &str) -> Result<(), DomainError> + Send + Sync;

/// The reads of one call, on the service's connection.
type LogReads<'reader> = SessionEventReads<'reader, &'reader DamagedFromSequenceReader>;

/// An event to append: every member of the stored envelope but `sequence`, which the writer mints
/// inside its transaction.
#[derive(Clone, Debug)]
pub(crate) struct UnsequencedEventEnvelope {
    /// The event's id.
    pub(crate) id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The session the event belongs to.
    pub(crate) session_id: SessionId,
    /// When the event occurred; stored in UTC to the millisecond.
    pub(crate) occurred_at: EventOccurredAt,
    /// The event's category.
    pub(crate) category: EventCategory,
    /// The event's type.
    pub(crate) event_type: EventEnvelopeType,
    /// Who acted: absent, `null` or a person's or an agent's id; absent is stored as `null`.
    #[expect(
        clippy::option_option,
        reason = "the envelope's actor tells absent from null, and this repeats it"
    )]
    pub(crate) actor: Option<Option<FreeFormText<EVENT_FIELD_MAX_LEN>>>,
    /// The category's own members.
    pub(crate) payload: Map<String, Value>,
    /// The id that ties this event to others of one operation.
    pub(crate) correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id of what caused this event.
    pub(crate) causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The producer's envelope version.
    pub(crate) version: EventEnvelopeVersion,
}

impl UnsequencedEventEnvelope {
    fn from_envelope(envelope: EventEnvelope) -> Self {
        Self {
            id: envelope.id,
            session_id: envelope.session_id,
            occurred_at: envelope.occurred_at,
            category: envelope.category,
            event_type: envelope.event_type,
            actor: envelope.actor,
            payload: envelope.payload,
            correlation_id: envelope.correlation_id,
            causation_id: envelope.causation_id,
            version: envelope.version,
        }
    }

    fn into_envelope(self, sequence: SafeInt<0>) -> EventEnvelope {
        EventEnvelope {
            id: self.id,
            session_id: self.session_id,
            sequence,
            occurred_at: self.occurred_at,
            category: self.category,
            event_type: self.event_type,
            actor: self.actor,
            payload: self.payload,
            correlation_id: self.correlation_id,
            causation_id: self.causation_id,
            version: self.version,
        }
    }
}

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
    /// each at its own sequence; each is checked as this one is and carries no content.
    pub(crate) preceding_events: Vec<UnsequencedEventEnvelope>,
    /// Whether someone waits on the write, so its batch goes to the database at once.
    pub(crate) is_waited_on: bool,
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
    /// The payload already carries a content description member, which only the append path sets.
    #[error(transparent)]
    SeededContentDescription(#[from] ContentDescriptionSeededError),
    /// The event's `occurredAt` cannot take the stored form.
    #[error("the event's occurredAt cannot be stored")]
    OccurredAt(#[from] OccurredAtNormalizationRefusal),
    /// A content body was given for a type that carries none.
    #[error(transparent)]
    ContentPartition(#[from] ContentPartitionRefusedError),
    /// The event does not parse as its registered variant.
    #[error(transparent)]
    RegisteredVariant(#[from] RegisteredVariantRefusal),
    /// The event has no canonical form, so its stored copy would not hold it faithfully.
    #[error("the event has no canonical form")]
    NoCanonicalForm(#[from] CanonicalizationRefusal),
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
    CursorUnresolvable(#[from] EventCursorUnresolvable),
    /// SQLite refused the read, or a stored row is not a well-formed event.
    #[error("the session's event log could not be read")]
    Read(#[from] SessionLogReadError),
    /// A stored position has no cursor, being past the safe integers.
    #[error("a read position has no event cursor")]
    CursorOutOfRange(#[from] EventCursorPositionOutOfRange),
    /// The service's connection is closed, or the read's blocking task did not finish.
    #[error(transparent)]
    Reader(#[from] DatabaseReaderError),
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
    followers: Arc<SessionEventFollowers>,
    projection_statements: Option<Box<ProjectionStatements>>,
    refuse_session_write: Option<Box<SessionWriteCheck>>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    reader: DatabaseReader,
}

impl EventLogService {
    /// The service over `dependencies`, with its own read-only connection on the database at
    /// `database_path`. Fails when that connection cannot be opened or set up.
    pub(crate) fn open(
        database_path: &Path,
        dependencies: EventLogServiceDependencies,
    ) -> Result<Self, CleanupFailures<rusqlite::Error>> {
        let reader = DatabaseReader::open(database_path, READER_STATEMENT_CAPACITY)?;
        let EventLogServiceDependencies {
            writer,
            followers,
            projection_statements,
            refuse_session_write,
            read_damaged_from_sequence,
        } = dependencies;
        let read_damaged_from_sequence = read_damaged_from_sequence.unwrap_or_else(|| {
            let reads_whole: Arc<DamagedFromSequenceReader> = Arc::new(|_: &SessionId| None::<i64>);
            reads_whole
        });
        Ok(Self {
            writer,
            followers,
            projection_statements,
            refuse_session_write,
            read_damaged_from_sequence,
            reader,
        })
    }

    /// Appends `envelope`, after any preceding events, and returns once it committed, with its
    /// sequence. Refuses, before anything is queued, an event of a session that takes no writes,
    /// a preceding event of another session, a seeded content description, a content body on a
    /// type that carries none, an event its registered variant rejects and one with no canonical
    /// form; then fails as the writer does, [`WriteError::Refused`] among it. An event is never
    /// refused for its size. Dropping the future once its write is queued neither withdraws the
    /// write nor its publication.
    pub(crate) async fn append(
        &self,
        envelope: UnsequencedEventEnvelope,
        options: EventLogAppendOptions,
    ) -> Result<EventLogAppendReceipt, EventAppendError> {
        if let Some(refuse_session_write) = &self.refuse_session_write {
            refuse_session_write(&envelope.session_id, envelope.event_type.as_str())
                .map_err(EventAppendError::SessionWriteRefused)?;
        }
        let EventLogAppendOptions {
            content_body,
            transactional_prelude,
            preceding_events,
            is_waited_on,
        } = options;
        // One clock reading for every event of the write.
        let monotonic_ns = monotonic_ns_now();
        let mut written = Vec::with_capacity(preceding_events.len() + 1);
        for preceding in preceding_events {
            if preceding.session_id != envelope.session_id {
                return Err(EventAppendError::PrecedingEventOfAnotherSession {
                    preceding_type: preceding.event_type.as_str().to_owned(),
                    preceding_session_id: preceding.session_id,
                    session_id: envelope.session_id,
                });
            }
            written.push(compose_row(preceding, None, monotonic_ns)?);
        }
        let session_id = envelope.session_id;
        let composed = compose_row(envelope, content_body.as_deref(), monotonic_ns)?;
        let id = composed.stored_envelope.id.clone();
        written.push(composed);

        let mut statements = transactional_prelude;
        if let Some(projection_statements) = &self.projection_statements {
            for event in &written {
                statements.extend(projection_statements(&event.stored_envelope));
            }
        }
        let (rows, stored_envelopes): (Vec<SessionEventRow>, Vec<UnsequencedEventEnvelope>) =
            written
                .into_iter()
                .map(|event| (event.row, event.stored_envelope))
                .unzip();
        let job = WriteJob {
            statements,
            events: rows,
        };
        let on_commit = publish_on_commit(stored_envelopes, Arc::clone(&self.followers));
        let write_options = WriteOptions { is_waited_on };

        // Queued under the session's lock, so its rows take their sequences in append order; the
        // lock is let go once the write is queued, and the commit is awaited outside it.
        let pending = SESSION_APPEND_LOCK
            .run(session_id, move || async move {
                self.writer.enqueue(job, write_options, Some(on_commit))
            })
            .await?;
        let committed = pending.await?;
        let sequence = committed
            .sequences
            .last()
            .copied()
            .expect("a committed write has a sequence per row, and an append writes one");
        Ok(EventLogAppendReceipt { id, sequence })
    }

    /// Up to `limit` events after the cursor's position, in sequence order. The session's head is
    /// read first and the cursor checked against it. Fails with
    /// [`EventLogReadError::CursorUnresolvable`] for a cursor that names no position or one past
    /// the session's last event, and as the read fails.
    pub(crate) async fn read_after_cursor(
        &self,
        request: EventReadAfterCursorRequest,
    ) -> Result<EventReadAfterCursorResponse, EventLogReadError> {
        self.read(move |reads| {
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
        self.read(move |reads| {
            let head = reads.read_head(&session_id)?;
            Ok(encode_event_cursor(head.unwrap_or(START_OF_LOG_POSITION))?)
        })
        .await
    }

    /// The events with a sequence from the request's first to its last, in sequence order. Fails
    /// as the read fails.
    pub(crate) async fn read_window(
        &self,
        request: EventReadWindowRequest,
    ) -> Result<EventReadWindowResponse, EventLogReadError> {
        self.read(move |reads| {
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

    /// Closes the service's connection once any running read is done; a later read fails with
    /// [`EventLogReadError::Reader`]. Fails with SQLite's refusal of the close.
    pub(crate) async fn close(&self) -> Result<(), DatabaseReaderCloseError> {
        self.reader.close().await
    }

    /// Runs `read` on the service's connection on a blocking thread.
    async fn read<Output: Send + 'static>(
        &self,
        read: impl FnOnce(&LogReads<'_>) -> Result<Output, EventLogReadError> + Send + 'static,
    ) -> Result<Output, EventLogReadError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.reader
            .read(move |connection| {
                read(&SessionEventReads::new(
                    connection,
                    &*read_damaged_from_sequence,
                ))
            })
            .await
    }
}

/// One event of an append as it will be stored: its row, and its envelope without the sequence.
struct ComposedEvent {
    row: SessionEventRow,
    stored_envelope: UnsequencedEventEnvelope,
}

/// The commit hook that pairs `stored_envelopes` with the sequences their write committed at and
/// publishes them to `followers` once, on the writer's queue task.
fn publish_on_commit(
    stored_envelopes: Vec<UnsequencedEventEnvelope>,
    followers: Arc<SessionEventFollowers>,
) -> CommitHook {
    Box::new(move |sequences: &[SafeInt<0>]| {
        let committed: Vec<EventEnvelope> = stored_envelopes
            .into_iter()
            .zip(sequences.iter().copied())
            .map(|(envelope, sequence)| envelope.into_envelope(sequence))
            .collect();
        followers.publish(&committed);
    })
}

/// Composes the row exactly as it will be stored, checked and canonicalized, and the envelope it
/// stores; everything bound comes from the composed envelope, never the caller's input.
fn compose_row(
    envelope: UnsequencedEventEnvelope,
    content_body: Option<&str>,
    monotonic_ns: i64,
) -> Result<ComposedEvent, EventAppendError> {
    // Checked before the content picks the branch: a seeded `contentLength` without content would
    // otherwise be stored as given.
    assert_no_seeded_content_description(&envelope.payload, APPEND_REFUSER)?;
    // Storage holds an absent actor and a `null` one as one NULL, while the canonical bytes tell
    // them apart, so the envelope takes the stored form before it is measured.
    let storable = EventEnvelope {
        id: envelope.id,
        session_id: envelope.session_id,
        sequence: SafeInt::ZERO,
        occurred_at: normalize_occurred_at(envelope.occurred_at.as_str())?,
        category: envelope.category,
        event_type: envelope.event_type,
        actor: Some(envelope.actor.flatten()),
        payload: envelope.payload,
        correlation_id: envelope.correlation_id,
        causation_id: envelope.causation_id,
        version: envelope.version,
    };
    let (composed, content_payload) = match content_body {
        None => (storable, None),
        Some(body) => {
            let content_row = compose_content_row(storable, body)?;
            (content_row.envelope, Some(content_row.stored_body))
        }
    };
    let composed = assert_registered_variant_parses(composed, APPEND_REFUSER)?;
    // Refuses before any write what the stored row could not hold faithfully.
    canonicalize_event(&composed)?;
    let row = SessionEventRow {
        id: composed.id.as_str().to_owned(),
        session_id: composed.session_id,
        occurred_at: composed.occurred_at.as_str().to_owned(),
        monotonic_ns,
        category: composed.category,
        event_type: composed.event_type.clone(),
        actor: composed
            .actor
            .clone()
            .flatten()
            .map(FreeFormText::into_string),
        payload: serde_json::to_string(&composed.payload).expect("a JSON object serializes"),
        correlation_id: composed
            .correlation_id
            .as_ref()
            .map(|correlation_id| correlation_id.as_str().to_owned()),
        causation_id: composed
            .causation_id
            .as_ref()
            .map(|causation_id| causation_id.as_str().to_owned()),
        version: composed.version.clone(),
        content_payload,
    };
    Ok(ComposedEvent {
        row,
        stored_envelope: UnsequencedEventEnvelope::from_envelope(composed),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use sidekicks_contracts::event::envelope::{EventCategory, EventEnvelopeType, EventOccurredAt};
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use tokio::sync::oneshot;

    use super::{
        EventLogAppendOptions, EventLogService, EventLogServiceDependencies,
        EventReadAfterCursorRequest, UnsequencedEventEnvelope,
    };
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WritesHeldError};
    use crate::events::session::followers::SessionEventFollowers;
    use crate::events::session::version::SESSION_EVENT_VERSION;
    use crate::uuid_v7::mint_uuid_v7;

    /// A held writer, the service on the same file, and the followers it publishes to.
    struct TestLog {
        /// Lets the writer's held writes go.
        release: oneshot::Sender<Result<(), WritesHeldError>>,
        writer: Arc<DatabaseWriter>,
        followers: Arc<SessionEventFollowers>,
        service: EventLogService,
    }

    /// A writer on `database` holding its writes until `release` answers, and the service on the
    /// same file.
    async fn open_log(database: &TestDatabase) -> TestLog {
        let (release, writes_held_until) = oneshot::channel();
        let writer = Arc::new(
            DatabaseWriter::open(
                database.opener(),
                DatabaseWriterOptions {
                    writes_held_until: Some(writes_held_until),
                    on_write_failed: None,
                },
            )
            .await
            .expect("the writer opens its database"),
        );
        let followers = Arc::new(SessionEventFollowers::default());
        let service = EventLogService::open(
            &database.path(),
            EventLogServiceDependencies {
                writer: Arc::clone(&writer),
                followers: Arc::clone(&followers),
                projection_statements: None,
                refuse_session_write: None,
                read_damaged_from_sequence: None,
            },
        )
        .expect("the service opens its reader");
        TestLog {
            release,
            writer,
            followers,
            service,
        }
    }

    /// A `tool.invoked` event of `session_id` its registered variant takes.
    fn tool_invoked(session_id: &SessionId) -> UnsequencedEventEnvelope {
        let payload = serde_json::from_value(json!({
            "sessionId": session_id,
            "runId": mint_uuid_v7().to_string(),
            "toolName": "Read",
        }))
        .expect("the payload is written as an object");
        UnsequencedEventEnvelope {
            id: FreeFormText::new(mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
            session_id: *session_id,
            occurred_at: EventOccurredAt::from_timestamp(jiff::Timestamp::now())
                .expect("now is after year 0000"),
            category: EventCategory::ToolActivity,
            event_type: EventEnvelopeType::from(SessionEventType::ToolInvoked),
            actor: None,
            payload,
            correlation_id: None,
            causation_id: None,
            version: SESSION_EVENT_VERSION.clone(),
        }
    }

    #[tokio::test]
    async fn every_committed_event_is_published_in_commit_order_though_its_caller_left() {
        let database = TestDatabase::new();
        let TestLog {
            release,
            writer,
            followers,
            service,
        } = open_log(&database).await;
        let heard = Arc::new(Mutex::new(Vec::new()));
        let _attachment = followers.follow_all({
            let heard = Arc::clone(&heard);
            move |event| {
                heard
                    .lock()
                    .expect("the test's list is not poisoned")
                    .push(event.sequence.get());
                Ok(())
            }
        });
        let session_id = test_session_id();
        let mut appends = [(); 3].map(|()| {
            Box::pin(service.append(tool_invoked(&session_id), EventLogAppendOptions::default()))
        });
        // Polled once each, every write is queued behind the hold.
        for append in &mut appends {
            assert!(futures::poll!(append).is_pending());
        }
        let [first, middle, last] = appends;
        drop(middle);

        release.send(Ok(())).expect("the writer waits on its hold");

        assert_eq!(
            first
                .await
                .expect("the first append commits")
                .sequence
                .get(),
            0
        );
        assert_eq!(
            last.await.expect("the last append commits").sequence.get(),
            2
        );
        assert_eq!(
            *heard.lock().expect("the test's list is not poisoned"),
            [0, 1, 2]
        );
        assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
    }

    #[tokio::test]
    async fn a_session_changes_only_once_its_event_can_be_read() {
        let database = TestDatabase::new();
        let TestLog {
            release,
            writer,
            followers,
            service,
        } = open_log(&database).await;
        let session_id = test_session_id();
        let mut change_count = followers.change_count(&session_id);
        let mut appended =
            Box::pin(service.append(tool_invoked(&session_id), EventLogAppendOptions::default()));
        assert!(futures::poll!(&mut appended).is_pending());
        assert!(
            !change_count
                .has_changed()
                .expect("the followers keep the count")
        );

        release.send(Ok(())).expect("the writer waits on its hold");
        change_count
            .changed()
            .await
            .expect("the followers keep the count");

        let page = service
            .read_after_cursor(EventReadAfterCursorRequest {
                session_id,
                after_cursor: None,
                limit: None,
            })
            .await
            .expect("the log reads");
        let sequences: Vec<u64> = page
            .events
            .iter()
            .map(|event| event.sequence.get())
            .collect();
        assert_eq!(sequences, [0]);
        assert!(!page.has_more);
        assert_eq!(
            appended.await.expect("the append commits").sequence.get(),
            0
        );
        assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
    }
}
