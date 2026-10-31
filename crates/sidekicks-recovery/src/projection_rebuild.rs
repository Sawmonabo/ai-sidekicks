//! Rebuilds a session's projections from its event log. A projection is a set of rows each event
//! writes in its own write; a rebuild deletes the session's rows and marks its cursor `rebuilding`
//! in one write, folds the log from its first event through each projection's own statements a
//! page at a time, each page in its own write, and in the last page's write settles what each
//! projection's fold leaves and marks the cursor `current` at the session's head. Rows seen while
//! the cursor is not `current` are not trusted, and a second rebuild writes the same rows.
//!
//! Only the event types a projection reads are read, so a type this build does not know stays a
//! stub in the log and is never converted. An event that fails to read as its envelope or its
//! registered variant, that a fold finds contradicts what it already applied, or whose rows a guard
//! or a constraint refuses, fails the session's rebuild as a projection failure naming that event.
//! Any other failure is the store's own, told to the damage watch. A rebuild can stop before a
//! given event, so a session whose history is damaged folds every event before its first damaged
//! one.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{Connection, ErrorCode, OptionalExtension as _, named_params};
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_session::service::{
    EventsReadAfterSequenceRequest, EventsReadAfterSequenceResponse, SessionService,
    SessionServiceError,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::damage::DatabaseDamageWatch;
use sidekicks_store::database::schema::recovery::ProjectionCursorState;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::projection::{
    ProjectionFailure, ProjectionFailureCause, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::append_lock::{SESSION_APPEND_LOCK, SessionAppendHold};
use sidekicks_store::events::session::read::SessionLogReadError;
use tokio_util::sync::CancellationToken;

/// The most events one page of a rebuild reads and writes: a page's envelopes and the statements
/// built from them are what a rebuild holds at once, and each page is one write.
pub(crate) const REBUILD_PAGE_SIZE: u32 = 1_000;

/// The statements the rebuild's own reads run: the sessions to rebuild, a session's cursor and its
/// log's head. Its pages are read through the session service, whose set counts those.
pub const PROJECTION_REBUILD_STATEMENT_CAPACITY: usize = 3;

// Every session with events has a cursor, written with each event, and a current one is at its
// newest sequence, so the sessions to rebuild are those whose cursor is not current.
static SELECT_SESSIONS_TO_REBUILD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT session_id FROM projection_cursors
  WHERE state <> '{}' AND session_id <> ?",
        <&str>::from(ProjectionCursorState::Current)
    )
});

const SELECT_CURSOR_SQL: &str =
    "SELECT last_sequence, state FROM projection_cursors WHERE session_id = ?";

// The head below `before_sequence`, every event when it is NULL.
const SELECT_HEAD_SEQUENCE_SQL: &str = "SELECT MAX(sequence) FROM session_events
  WHERE session_id = @session_id AND (@before_sequence IS NULL OR sequence < @before_sequence)";

// Goes with the clear, so the cursor reflects no event until a page lands.
static MARK_REBUILDING_SQL: LazyLock<String> = LazyLock::new(|| {
    let rebuilding = <&str>::from(ProjectionCursorState::Rebuilding);
    format!(
        "INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, {START_OF_LOG_POSITION}, '{rebuilding}', {DATABASE_NOW_SQL})
  ON CONFLICT (session_id) DO UPDATE
    SET last_sequence = excluded.last_sequence, state = '{rebuilding}',
        updated_at = excluded.updated_at"
    )
});

// Goes with each page: still rebuilding at the page's last event, so a rebuild that fails later
// says how far its rows reached; with the last page, current at the log's head, or stale where a
// rebuild stopped before damaged events, so the next restart lists the session again.
static ADVANCE_CURSOR_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projection_cursors
  SET state = @state, last_sequence = @last_sequence, updated_at = {DATABASE_NOW_SQL}
  WHERE session_id = @session_id"
    )
});

static MARK_STALE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projection_cursors
  SET state = '{}', updated_at = {DATABASE_NOW_SQL}
  WHERE session_id = @session_id",
        <&str>::from(ProjectionCursorState::Stale)
    )
});

/// Why a rebuild, or a read of what needs one, failed.
#[derive(Debug, thiserror::Error)]
pub enum ProjectionRebuildError {
    /// The log cannot be folded into rows; the session's cursor was marked stale, and the failure
    /// of marking it rides beside when that failed too.
    #[error("a session's projections were not rebuilt from its log")]
    ProjectionFailure(#[source] Box<CleanupFailures<ProjectionFailure, WriteError>>),
    /// The stop token was canceled before a page; the cursor is left `rebuilding`, so the next pass
    /// rebuilds the session.
    #[error("the rebuild was stopped before its next page")]
    Stopped,
    /// A write of the rebuild was not kept.
    #[error("a write of the rebuild was not kept")]
    Write(#[source] WriteError),
    /// A page of the session's log could not be read.
    #[error("a page of the session's log could not be read")]
    Read(#[source] SessionServiceError),
    /// SQLite refused a read of the cursors or the log's head, or a stored column does not read.
    #[error("a read of the projection cursors failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error("the read pool did not run the rebuild's read")]
    Pool(#[from] DatabaseReadError),
    /// The caller's hold is of another session than the one it asked to rebuild; nothing was read
    /// or written.
    #[error("a hold of session {held_session_id} cannot rebuild session {session_id}")]
    HoldOfAnotherSession {
        /// The session the hold is on.
        held_session_id: SessionId,
        /// The session the rebuild names.
        session_id: SessionId,
    },
}

/// A rebuild of one session: `is_forced` rebuilds it even when its projections are current,
/// `before_sequence` folds only the events before that one, leaving the cursor stale, and `stop`
/// ends it before its next page with the cursor left `rebuilding`.
#[derive(Clone, Debug)]
pub(crate) struct ProjectionRebuildRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Whether to rebuild projections that are already current.
    pub(crate) is_forced: bool,
    /// Only events before this sequence are folded.
    pub(crate) before_sequence: Option<i64>,
    /// Ends the rebuild before its next page once canceled.
    pub(crate) stop: Option<CancellationToken>,
}

/// What a rebuild did: the projections it replaced and the last event they reflect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectionRebuildResponse {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The projections replaced; empty when they were already current.
    pub(crate) rebuilt_projections: Vec<&'static str>,
    /// The last event the rows reflect, `-1` for a log with none.
    pub(crate) as_of_sequence: i64,
    /// The events the rebuild read.
    pub(crate) events_applied: usize,
}

/// Rebuilds sessions' projections from their logs, and lists the sessions that need it. Every
/// failure is told to the damage watch on its way out, which counts only a damaged file.
pub struct ProjectionRebuildService {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    session_events: Arc<SessionService>,
    damage: Arc<DatabaseDamageWatch>,
    projections: Vec<RebuiltProjection>,
    // Every type some projection reads, each once, as the page reads name them; shared with each
    // page's read rather than copied into it.
    event_types: Arc<[String]>,
}

// A projection and the types its fold reads, as a set the fold loop checks each event against.
struct RebuiltProjection {
    projection: Box<dyn SessionProjection>,
    event_types: HashSet<SessionEventType>,
}

// The events one rebuild folds: the session's, up to `head_sequence`, before `before_sequence`.
struct FoldRange<'request> {
    session_id: SessionId,
    head_sequence: i64,
    before_sequence: Option<i64>,
    stop: Option<&'request CancellationToken>,
}

// How a rebuild's fold failed: the log, which marks the cursor stale, or anything else.
enum FoldFailure {
    Projection(ProjectionFailure),
    Rebuild(ProjectionRebuildError),
}

struct CursorRow {
    last_sequence: i64,
    state: ProjectionCursorState,
}

impl ProjectionRebuildService {
    /// The service reading cursors and heads through `pool`, the log's pages through
    /// `session_events`, writing through `writer` and telling `damage` of each store failure;
    /// `projections` are the ones a rebuild replaces, in the order their statements run.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        session_events: Arc<SessionService>,
        damage: Arc<DatabaseDamageWatch>,
        projections: Vec<Box<dyn SessionProjection>>,
    ) -> Self {
        let projections: Vec<RebuiltProjection> = projections
            .into_iter()
            .map(|projection| RebuiltProjection {
                event_types: projection.event_types().iter().copied().collect(),
                projection,
            })
            .collect();
        let event_types = projections
            .iter()
            .flat_map(|rebuilt| rebuilt.event_types.iter().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|event_type| event_type.as_str().to_owned())
            .collect();
        Self {
            pool,
            writer,
            session_events,
            damage,
            projections,
            event_types,
        }
    }

    /// Every session but the service's own whose projections do not reflect its newest event: its
    /// cursor was left stale or mid-rebuild, or a repair marked it. Fails with
    /// [`ProjectionRebuildError::Database`] or [`ProjectionRebuildError::Pool`].
    pub(crate) async fn list_sessions_to_rebuild(
        &self,
    ) -> Result<Vec<SessionId>, ProjectionRebuildError> {
        let sessions = self
            .pool
            .read(
                ReadLength::Short,
                |reader: &Connection| -> Result<Vec<SessionId>, ProjectionRebuildError> {
                    let sentinel = DAEMON_SCOPE_SENTINEL_SESSION_ID.text();
                    let mut statement = reader.prepare_cached(&SELECT_SESSIONS_TO_REBUILD_SQL)?;
                    let sessions = statement
                        .query_map([sentinel.as_str()], |row| {
                            text_column(row, 0, |text| SessionId::new(&text))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(sessions)
                },
            )
            .await;
        self.reported(sessions)
    }

    /// The last event sequence the session's projection rows reflect, by its cursor; `None` when
    /// the session has no cursor or its rows reflect no event. Fails as
    /// [`ProjectionRebuildService::list_sessions_to_rebuild`] does.
    #[expect(dead_code, reason = "the daemon's recovery pass at start")]
    pub(crate) async fn read_last_applied_sequence(
        &self,
        session_id: SessionId,
    ) -> Result<Option<i64>, ProjectionRebuildError> {
        let cursor = self
            .pool
            .read(
                ReadLength::Short,
                move |reader: &Connection| -> Result<_, ProjectionRebuildError> {
                    Ok(read_cursor(reader, &session_id)?)
                },
            )
            .await;
        Ok(self
            .reported(cursor)?
            .map(|cursor| cursor.last_sequence)
            .filter(|last_sequence| *last_sequence >= 0))
    }

    /// The session's newest event's sequence, `-1` for a log with none. Fails as
    /// [`ProjectionRebuildService::list_sessions_to_rebuild`] does.
    pub(crate) async fn read_head_sequence(
        &self,
        session_id: SessionId,
    ) -> Result<i64, ProjectionRebuildError> {
        let head = self
            .pool
            .read(
                ReadLength::Short,
                move |reader: &Connection| -> Result<_, ProjectionRebuildError> {
                    Ok(read_head_sequence_before(reader, &session_id, None)?)
                },
            )
            .await;
        self.reported(head)
    }

    /// Rebuilds the session's projections unless they are current and `is_forced` is not set,
    /// holding the session's append lock throughout, so no event lands while it reads and writes:
    /// `hold` where the caller holds the session already, else a hold the rebuild takes. Fails
    /// with [`ProjectionRebuildError::HoldOfAnotherSession`] for a hold of another session; with
    /// [`ProjectionRebuildError::ProjectionFailure`] naming the first event it could not fold,
    /// after marking the session's cursor stale, when the log cannot be folded into rows; with
    /// [`ProjectionRebuildError::Stopped`] once `stop` is canceled; any other failure is the
    /// store's own.
    pub(crate) async fn rebuild(
        &self,
        request: ProjectionRebuildRequest,
        hold: Option<&SessionAppendHold>,
    ) -> Result<ProjectionRebuildResponse, ProjectionRebuildError> {
        let rebuilt = match hold {
            Some(hold) if *hold.key() != request.session_id => {
                Err(ProjectionRebuildError::HoldOfAnotherSession {
                    held_session_id: *hold.key(),
                    session_id: request.session_id,
                })
            }
            Some(_) => self.rebuild_held(request).await,
            None => {
                let _hold = SESSION_APPEND_LOCK.acquire(request.session_id).await;
                self.rebuild_held(request).await
            }
        };
        self.reported(rebuilt)
    }

    // The rebuild, run while the session's append lock is held.
    async fn rebuild_held(
        &self,
        request: ProjectionRebuildRequest,
    ) -> Result<ProjectionRebuildResponse, ProjectionRebuildError> {
        let ProjectionRebuildRequest {
            session_id,
            is_forced,
            before_sequence,
            stop,
        } = request;
        // Appends queued before the hold commit first, so the reads below see them.
        self.writer.flush().await;
        let (head_sequence, cursor) = self
            .pool
            .read(
                ReadLength::Short,
                move |reader: &Connection| -> Result<_, ProjectionRebuildError> {
                    Ok((
                        read_head_sequence_before(reader, &session_id, before_sequence)?,
                        read_cursor(reader, &session_id)?,
                    ))
                },
            )
            .await?;
        if !is_forced
            && let Some(cursor) = cursor.filter(|cursor| {
                cursor.state == ProjectionCursorState::Current
                    && cursor.last_sequence >= head_sequence
            })
        {
            return Ok(ProjectionRebuildResponse {
                session_id,
                rebuilt_projections: Vec::new(),
                as_of_sequence: cursor.last_sequence,
                events_applied: 0,
            });
        }
        let range = FoldRange {
            session_id,
            head_sequence,
            before_sequence,
            stop: stop.as_ref(),
        };
        match self.rebuild_from_first_event(&range).await {
            Ok(response) => Ok(response),
            Err(FoldFailure::Rebuild(error)) => Err(error),
            Err(FoldFailure::Projection(failure)) => Err(self.mark_stale(failure).await),
        }
    }

    // Clears the session's rows, marks its cursor rebuilding, then folds its log.
    async fn rebuild_from_first_event(
        &self,
        range: &FoldRange<'_>,
    ) -> Result<ProjectionRebuildResponse, FoldFailure> {
        let mut statements: Vec<WriteStatement> = self
            .projections
            .iter()
            .flat_map(|rebuilt| rebuilt.projection.clear_statements(&range.session_id))
            .collect();
        statements.push(mark_rebuilding_statement(&range.session_id));
        self.writer
            .write(statements)
            .await
            .map_err(|error| FoldFailure::Rebuild(ProjectionRebuildError::Write(error)))?;
        let events_applied = self.fold_pages(range).await?;
        Ok(ProjectionRebuildResponse {
            session_id: range.session_id,
            rebuilt_projections: self
                .projections
                .iter()
                .map(|rebuilt| rebuilt.projection.name())
                .collect(),
            as_of_sequence: range.head_sequence,
            events_applied,
        })
    }

    // Folds the log a page at a time, writing each page's statements in its own write; the last
    // page's write marks the cursor folded at the head. Returns the events read. A refused page
    // names the event whose statement it refused.
    async fn fold_pages(&self, range: &FoldRange<'_>) -> Result<usize, FoldFailure> {
        let session_id = range.session_id;
        let mut folds: Vec<(&HashSet<SessionEventType>, Box<dyn SessionProjectionFold>)> = self
            .projections
            .iter()
            .map(|rebuilt| (&rebuilt.event_types, rebuilt.projection.fold(&session_id)))
            .collect();
        let mut after_sequence = START_OF_LOG_POSITION;
        let mut events_read = 0;
        loop {
            if range.stop.is_some_and(CancellationToken::is_cancelled) {
                return Err(FoldFailure::Rebuild(ProjectionRebuildError::Stopped));
            }
            let EventsReadAfterSequenceResponse {
                events,
                next_sequence,
                has_more,
            } = self.read_page(range, after_sequence).await?;
            let mut statements = Vec::new();
            // Each event's sequence beside the end of its statements, so a refused statement
            // names its event.
            let mut event_ends: Vec<(usize, i64)> = Vec::with_capacity(events.len());
            for envelope in &events {
                let sequence = i64::from(envelope.sequence);
                let failure = |cause| {
                    FoldFailure::Projection(ProjectionFailure {
                        session_id,
                        sequence,
                        cause,
                    })
                };
                let event = SessionEvent::from_envelope(envelope)
                    .map_err(|error| failure(ProjectionFailureCause::NotItsVariant(error)))?;
                let event_type = event.event_type();
                for (event_types, fold) in &mut folds {
                    if event_types.contains(&event_type) {
                        fold.apply(envelope, &event, &mut statements)
                            .map_err(|contradiction| {
                                failure(ProjectionFailureCause::Contradicted(contradiction))
                            })?;
                    }
                }
                event_ends.push((statements.len(), sequence));
            }
            events_read += events.len();
            // The page's envelopes are done with once its statements are built.
            drop(events);
            if !has_more {
                statements.extend(
                    self.projections
                        .iter()
                        .flat_map(|rebuilt| rebuilt.projection.closing_statements(&session_id)),
                );
            }
            let (last_sequence, state) = if has_more {
                (next_sequence, ProjectionCursorState::Rebuilding)
            } else if range.before_sequence.is_none() {
                (range.head_sequence, ProjectionCursorState::Current)
            } else {
                (range.head_sequence, ProjectionCursorState::Stale)
            };
            statements.push(advance_cursor_statement(&session_id, last_sequence, state));
            if let Err(error) = self.writer.write(statements).await {
                return Err(page_write_failure(session_id, &event_ends, error));
            }
            if !has_more {
                return Ok(events_read);
            }
            after_sequence = next_sequence;
        }
    }

    // A stored row that does not read is a log the rows cannot be built from, not a failing store.
    async fn read_page(
        &self,
        range: &FoldRange<'_>,
        after_sequence: i64,
    ) -> Result<EventsReadAfterSequenceResponse, FoldFailure> {
        let page = self
            .session_events
            .read_events_after_sequence(EventsReadAfterSequenceRequest {
                session_id: range.session_id,
                after_sequence,
                limit: Some(REBUILD_PAGE_SIZE),
                event_types: Some(Arc::clone(&self.event_types)),
                before_sequence: range.before_sequence,
            })
            .await;
        page.map_err(|error| match error {
            SessionServiceError::Log(SessionLogReadError::Malformed(malformed)) => {
                FoldFailure::Projection(ProjectionFailure {
                    session_id: range.session_id,
                    sequence: malformed.sequence,
                    cause: ProjectionFailureCause::Unreadable(malformed),
                })
            }
            error @ (SessionServiceError::Log(SessionLogReadError::Database(_))
            | SessionServiceError::Refused(_)
            | SessionServiceError::Database(_)
            | SessionServiceError::RunNamesNoAgent { .. }
            | SessionServiceError::RunNamesNoAccount { .. }
            | SessionServiceError::Rebuild(_)
            | SessionServiceError::Pool(_)) => {
                FoldFailure::Rebuild(ProjectionRebuildError::Read(error))
            }
        })
    }

    // Marks the session's cursor stale after a projection failure, so the next restart lists it
    // again; a failure of that write is told to the watch and rides beside the projection failure.
    async fn mark_stale(&self, failure: ProjectionFailure) -> ProjectionRebuildError {
        let marked = self
            .writer
            .write(vec![mark_stale_statement(&failure.session_id)])
            .await;
        let cleanup_failures = match marked {
            Ok(_) => Vec::new(),
            Err(error) => {
                self.damage.report(&error);
                vec![error]
            }
        };
        ProjectionRebuildError::ProjectionFailure(Box::new(CleanupFailures::new(
            failure,
            cleanup_failures,
            "marking the session's projections stale",
        )))
    }

    // Tells the watch of a failure on its way to the caller; only a damaged file counts.
    fn reported<T>(
        &self,
        result: Result<T, ProjectionRebuildError>,
    ) -> Result<T, ProjectionRebuildError> {
        if let Err(error) = &result {
            self.damage.report(error);
        }
        result
    }
}

// The session's newest sequence before `before_sequence`, of its whole log when that is `None`;
// the start of the log when it holds none there.
fn read_head_sequence_before(
    reader: &Connection,
    session_id: &SessionId,
    before_sequence: Option<i64>,
) -> rusqlite::Result<i64> {
    let head: Option<i64> = reader.prepare_cached(SELECT_HEAD_SEQUENCE_SQL)?.query_row(
        named_params! {
            "@session_id": session_id.text().as_str(),
            "@before_sequence": before_sequence,
        },
        |row| row.get(0),
    )?;
    Ok(head.unwrap_or(START_OF_LOG_POSITION))
}

fn read_cursor(reader: &Connection, session_id: &SessionId) -> rusqlite::Result<Option<CursorRow>> {
    reader
        .prepare_cached(SELECT_CURSOR_SQL)?
        .query_row([session_id.text().as_str()], |row| {
            Ok(CursorRow {
                last_sequence: row.get(0)?,
                state: text_column(row, 1, closed_word)?,
            })
        })
        .optional()
}

// A page's failed write as the fold reads it: a refused guard or a broken constraint in an event's
// statements is that event's projection failure; anything else, the cursor's statement included,
// is the store's own.
fn page_write_failure(
    session_id: SessionId,
    event_ends: &[(usize, i64)],
    error: WriteError,
) -> FoldFailure {
    let event = contradicted_statement_index(&error)
        .and_then(|index| event_ends.get(event_ends.partition_point(|(end, _)| *end <= index)));
    match event {
        Some(&(_, sequence)) => FoldFailure::Projection(ProjectionFailure {
            session_id,
            sequence,
            cause: ProjectionFailureCause::RowsRefused(error),
        }),
        None => FoldFailure::Rebuild(ProjectionRebuildError::Write(error)),
    }
}

// The statement a guard refused or a constraint failed, which only a contradicting log makes; any
// other SQLite failure is the store's own.
fn contradicted_statement_index(error: &WriteError) -> Option<usize> {
    if let Some((statement_index, source)) = error.failed_statement() {
        return (source.sqlite_error_code() == Some(ErrorCode::ConstraintViolation))
            .then_some(statement_index);
    }
    error.refused_statement_index()
}

fn session_binding(session_id: &SessionId) -> (Cow<'static, str>, Value) {
    text_binding("@session_id", session_id.text().as_str())
}

fn cursor_statement(
    sql: &'static str,
    bindings: Vec<(Cow<'static, str>, Value)>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }
}

fn mark_rebuilding_statement(session_id: &SessionId) -> WriteStatement {
    cursor_statement(
        MARK_REBUILDING_SQL.as_str(),
        vec![
            text_binding("@id", &mint_uuid_v7().to_string()),
            session_binding(session_id),
        ],
    )
}

/// The write that marks `session_id`'s cursor stale, so the next restart lists the session again
/// and the writer's count of live runs leaves its runs out.
pub(crate) fn mark_stale_statement(session_id: &SessionId) -> WriteStatement {
    cursor_statement(MARK_STALE_SQL.as_str(), vec![session_binding(session_id)])
}

fn advance_cursor_statement(
    session_id: &SessionId,
    last_sequence: i64,
    state: ProjectionCursorState,
) -> WriteStatement {
    cursor_statement(
        ADVANCE_CURSOR_SQL.as_str(),
        vec![
            session_binding(session_id),
            (
                Cow::Borrowed("@last_sequence"),
                Value::Integer(last_sequence),
            ),
            text_binding("@state", <&str>::from(state)),
        ],
    )
}

#[cfg(test)]
mod tests;
