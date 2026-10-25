//! A session whose history cannot be rebuilt whole. Its last good point is every event before the
//! first one that cannot be read: a row that is not a well-formed event, an event its registered
//! shape refuses, or one the projections' fold cannot take. The session's projections are rebuilt
//! through that point and it opens there, read-only, until the person continues it from there or
//! deletes it. The damaged rows are never moved, rewritten or deleted; a continue skips them.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionTargetRequest;
use sidekicks_contracts::session::recovery::{
    SessionDamagedEventsSkippedPayload, SessionHistoryDamagedRecovery,
    SessionRecoveryRefusedDetails, SessionRecoveryRefusedReason,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio_util::sync::CancellationToken;

use crate::cleanup_failures::CleanupFailures;
use crate::daemon::scheduler::budget::ProcessorMeter;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::events::session::append_lock::{SESSION_APPEND_LOCK, SessionAppendHold};
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::events::session::purge::rows::PurgeCaller;
use crate::events::session::purge::{SessionPurge, SessionPurgeError, SessionPurgeOutcome};
use crate::events::session::read::SessionLogReadError;
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::keyed_lock::KeyedLock;
use crate::recovery::projection_rebuild::{
    ProjectionFailure, ProjectionRebuildError, ProjectionRebuildRequest, ProjectionRebuildService,
    REBUILD_PAGE_SIZE, mark_stale_statement,
};
use crate::recovery::restart_settle::{RestartSettle, RestartSettleError};
use crate::recovery::status::{LastGoodPoint, RecoveryStatusTracker};
use crate::session::directory::lookups::session_exists;
use crate::session::service::{
    EventsReadAfterSequenceRequest, SessionService, SessionServiceError,
};

/// The statements damaged history's own reads run: the last event before a damaged one, and
/// whether a session has a row.
pub(crate) const DAMAGED_HISTORY_STATEMENT_CAPACITY: usize = 2;

// The last event the session opens at: the newest one before the first damaged event that no
// skipped range holds.
static SELECT_LAST_EVENT_BEFORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence, occurred_at FROM session_events AS event
  WHERE session_id = @session_id AND sequence < @before_sequence
    AND {}
  ORDER BY sequence DESC
  LIMIT 1",
        outside_skipped_ranges_sql("event")
    )
});

/// What damaged history reads, writes and rebuilds through.
pub(crate) struct DamagedHistoryDeps {
    /// The reads of a session's last good point and of its row.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The pages of a session's log, read for its first unreadable event.
    pub(crate) session_events: Arc<SessionService>,
    /// The append of the skip a continue writes.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The writer a continue flushes before it reads the head, and marks a cursor stale through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The rebuilds through a last good point, and past the skip.
    pub(crate) projection_rebuild: Arc<ProjectionRebuildService>,
    /// What the restart left in a continued session, settled.
    pub(crate) restart_settle: Arc<RestartSettle>,
    /// The purge `Delete session` runs.
    pub(crate) purge: Arc<SessionPurge>,
    /// The recovery state that says which sessions are damaged.
    pub(crate) status: Arc<RecoveryStatusTracker>,
}

/// Finds a damaged session's last good point and rebuilds its projections through it, and runs
/// the person's two actions on it, one at a time per session.
pub(crate) struct DamagedHistory {
    deps: DamagedHistoryDeps,
    // Held across an action's check and its act, so a delete never meets a session a continue has
    // just opened.
    recovery_actions: KeyedLock<SessionId>,
}

/// Why `Continue from here` or `Delete session` was refused or failed; nothing is written on a
/// refusal.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RecoveryActionError {
    /// No session of that id is held.
    #[error("no session {0} is held")]
    NotFound(SessionId),
    /// The session's history is not damaged, or none of it can be read, which leaves only delete.
    #[error("session {session_id} cannot take that recovery action")]
    Refused {
        /// The session.
        session_id: SessionId,
        /// Why.
        reason: SessionRecoveryRefusedReason,
    },
    /// The read of the session's row failed.
    #[error("the session's row could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool failed the read.
    #[error("the session's row could not be read")]
    Pool(#[from] DatabaseReadError),
    /// The head read or a rebuild failed.
    #[error(transparent)]
    Rebuild(#[from] ProjectionRebuildError),
    /// The skip broke its type's checks.
    #[error(transparent)]
    Draft(#[from] SessionEventDraftError),
    /// The skip was not appended.
    #[error("the skip of the damaged events was not appended")]
    Skip(#[source] SessionEventAppendError),
    /// What the restart left in the session was not settled.
    #[error(transparent)]
    Settle(#[from] RestartSettleError),
    /// A continue failed after its skip: the session is back at its point, its cursor marked
    /// stale so the next start rebuilds it past the skip, the mark's own failure beside it.
    #[error(transparent)]
    Unfinished(Box<CleanupFailures<RecoveryActionError, WriteError>>),
    /// The purge refused the session or failed.
    #[error("the session was not deleted")]
    Purge(#[source] SessionPurgeError),
}

impl From<RecoveryActionError> for HandlerError {
    /// A session not held and an action it cannot take answer their refusals; any other failure is
    /// a fault in the daemon.
    fn from(error: RecoveryActionError) -> Self {
        match error {
            RecoveryActionError::NotFound(session_id) => {
                Self::Refused(DomainError::session_not_found(
                    format!("No session {session_id} is held"),
                    SessionTargetRequest { session_id },
                ))
            }
            RecoveryActionError::Refused { session_id, reason } => Self::Refused(
                DomainError::new(
                    format!("Session {session_id} cannot take that recovery action"),
                    RefusalCode::SessionRecoveryRefused,
                )
                .with_detail(SessionRecoveryRefusedDetails { session_id, reason }),
            ),
            fault @ (RecoveryActionError::Read(_)
            | RecoveryActionError::Pool(_)
            | RecoveryActionError::Rebuild(_)
            | RecoveryActionError::Draft(_)
            | RecoveryActionError::Skip(_)
            | RecoveryActionError::Settle(_)
            | RecoveryActionError::Unfinished(_)
            | RecoveryActionError::Purge(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Why a session's last good point was not found; the store's own failures, as they came.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DamagedHistoryError {
    /// The rebuild through the point failed other than at an event before it.
    #[error("the session's projections were not rebuilt through its last good point")]
    Rebuild(#[from] ProjectionRebuildError),
    /// A page of the session's log could not be read.
    #[error("a page of the session's log could not be read")]
    Log(#[source] SessionServiceError),
    /// A read of the last event before the damage failed.
    #[error("the session's last good event could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool failed the read.
    #[error("the session's last good event could not be read")]
    Pool(#[from] DatabaseReadError),
}

impl DamagedHistory {
    /// Damaged history over `deps`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(deps: DamagedHistoryDeps) -> Self {
        Self {
            deps,
            recovery_actions: KeyedLock::new(),
        }
    }

    /// `Continue from here`: under one hold of the session's appends, skips its damaged events
    /// through its head, rebuilds it past them and ends its live runs and pending retries; then
    /// settles what its ended runs left, and it takes work again. Refuses a session not held
    /// [`RecoveryActionError::NotFound`], and one not damaged or with no readable event
    /// [`RecoveryActionError::Refused`]; a failure after the skip leaves the session at its point
    /// and keeps the skip, so the next start rebuilds past it.
    pub(crate) async fn continue_from_last_good_point(
        &self,
        session_id: SessionId,
    ) -> Result<(), RecoveryActionError> {
        let _action = self.recovery_actions.acquire(session_id).await;
        let status = &self.deps.status;
        let point = match status.read_session_write_refusal(&session_id) {
            Some(SessionHistoryDamagedRecovery::Degraded) => {
                status.read_last_good_point(&session_id)
            }
            Some(SessionHistoryDamagedRecovery::Damaged) => None,
            None => return Err(self.refusal_of_undamaged(session_id).await),
        };
        let Some(point) = point else {
            return Err(RecoveryActionError::Refused {
                session_id,
                reason: SessionRecoveryRefusedReason::NoReadableEvent,
            });
        };
        let hold = SESSION_APPEND_LOCK.acquire(session_id).await;
        // An append that let the lock go before its commit lands first, so the head names it.
        self.deps.writer.flush().await;
        let head = self
            .deps
            .projection_rebuild
            .read_head_sequence(session_id)
            .await?;
        let skip = SessionEvent::SessionDamagedEventsSkipped(SessionDamagedEventsSkippedPayload {
            session_id,
            from_sequence: point.damaged_from_sequence,
            to_sequence: sequence_of(head).expect("a damaged log's head is a sequence"),
        });
        self.deps
            .appender
            .append_held(
                &hold,
                SessionEventDraft::of_session(session_id, &skip)?,
                SessionEventLinkage::default(),
            )
            .await
            .map_err(RecoveryActionError::Skip)?;
        status.mark_session_continuing(&session_id);
        let continued = self.continue_held(session_id, &hold).await;
        drop(hold);
        let continued = match continued {
            Ok(()) => self
                .deps
                .restart_settle
                .settle_ended(session_id, None)
                .await
                .map_err(RecoveryActionError::from),
            Err(failure) => Err(failure),
        };
        match continued {
            Ok(()) => {
                status.mark_session_healthy(&session_id);
                Ok(())
            }
            Err(failure) => Err(self.mark_back_at_point(session_id, point, failure).await),
        }
    }

    /// `Delete session` on a damaged session: every row of it goes, the copy set aside stays.
    /// Refuses a session whose history is not damaged as
    /// [`DamagedHistory::continue_from_last_good_point`] does, and fails with the purge's refusal.
    pub(crate) async fn delete_damaged_session(
        &self,
        session_id: SessionId,
    ) -> Result<(), RecoveryActionError> {
        let _action = self.recovery_actions.acquire(session_id).await;
        if self
            .deps
            .status
            .read_session_write_refusal(&session_id)
            .is_none()
        {
            return Err(self.refusal_of_undamaged(session_id).await);
        }
        let report = self
            .deps
            .purge
            .purge(
                &[session_id],
                PurgeCaller::DamagedHistory,
                &ProcessorMeter::default(),
            )
            .await;
        let (_, outcome) = report
            .outcomes
            .into_iter()
            .next()
            .expect("a purge answers one outcome for each session id it was given");
        match outcome {
            SessionPurgeOutcome::Refused(failure) => Err(RecoveryActionError::Purge(failure)),
            SessionPurgeOutcome::Removed { .. } => Ok(()),
        }
    }

    // The rebuild past the skip and the settle of the live runs, under the continue's hold.
    async fn continue_held(
        &self,
        session_id: SessionId,
        hold: &SessionAppendHold,
    ) -> Result<(), RecoveryActionError> {
        self.deps
            .projection_rebuild
            .rebuild(
                ProjectionRebuildRequest {
                    session_id,
                    is_forced: true,
                    before_sequence: None,
                    stop: None,
                },
                Some(hold),
            )
            .await?;
        self.deps
            .restart_settle
            .settle_live(session_id, Some(hold), None)
            .await?;
        Ok(())
    }

    // Puts a session whose continue failed after its skip back at `point`, its cursor marked stale
    // first so the next start rebuilds it past the skip.
    async fn mark_back_at_point(
        &self,
        session_id: SessionId,
        point: LastGoodPoint,
        failure: RecoveryActionError,
    ) -> RecoveryActionError {
        let marked = self
            .deps
            .writer
            .write(vec![mark_stale_statement(&session_id)])
            .await;
        self.deps
            .status
            .mark_session_at_last_good_point(&session_id, point);
        RecoveryActionError::Unfinished(Box::new(CleanupFailures::new(
            failure,
            marked.err().into_iter().collect(),
            "continuing a damaged session",
        )))
    }

    // The refusal of an action on a session the recovery state holds no damage of.
    async fn refusal_of_undamaged(&self, session_id: SessionId) -> RecoveryActionError {
        let exists = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RecoveryActionError>(session_exists(reader, &session_id)?)
            })
            .await;
        match exists {
            Ok(true) => RecoveryActionError::Refused {
                session_id,
                reason: SessionRecoveryRefusedReason::NotDamaged,
            },
            Ok(false) => RecoveryActionError::NotFound(session_id),
            Err(failure) => failure,
        }
    }

    /// Rebuilds the session's projections through its last good point after `failure` stopped its
    /// rebuild, and answers the point: the first event that cannot be read or folded, moved back
    /// to an earlier event that still contradicts the fold. `None` when no event before it can be
    /// read. Each rebuild ends before its next page once `stop` fires, failing with
    /// [`ProjectionRebuildError::Stopped`]; any other failure is the store's own, as it came.
    pub(crate) async fn rebuild_through_last_good_point(
        &self,
        failure: &ProjectionFailure,
        stop: &CancellationToken,
    ) -> Result<Option<LastGoodPoint>, DamagedHistoryError> {
        let session_id = failure.session_id;
        let first_unreadable = self.find_first_unreadable_sequence(session_id).await?;
        let mut damaged_from_sequence = first_unreadable.map_or(failure.sequence, |unreadable| {
            unreadable.min(failure.sequence)
        });
        loop {
            let rebuilt = self
                .deps
                .projection_rebuild
                .rebuild(
                    ProjectionRebuildRequest {
                        session_id,
                        is_forced: true,
                        before_sequence: Some(damaged_from_sequence),
                        stop: Some(stop.clone()),
                    },
                    None,
                )
                .await;
            match rebuilt {
                Ok(_rebuilt) => break,
                Err(ProjectionRebuildError::ProjectionFailure(failures))
                    if failures.original().sequence < damaged_from_sequence =>
                {
                    damaged_from_sequence = failures.original().sequence;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let point = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_last_good_point(reader, &session_id, damaged_from_sequence)
            })
            .await?;
        Ok(point)
    }

    // The first event of the session that is not a well-formed event or that its registered shape
    // refuses, read across every type; `None` when every event reads.
    async fn find_first_unreadable_sequence(
        &self,
        session_id: SessionId,
    ) -> Result<Option<i64>, DamagedHistoryError> {
        let mut after_sequence = START_OF_LOG_POSITION;
        loop {
            let page = match self
                .deps
                .session_events
                .read_events_after_sequence(EventsReadAfterSequenceRequest {
                    session_id,
                    after_sequence,
                    limit: Some(REBUILD_PAGE_SIZE),
                    event_types: None,
                    before_sequence: None,
                })
                .await
            {
                Ok(page) => page,
                Err(SessionServiceError::Log(SessionLogReadError::Malformed(malformed))) => {
                    return Ok(Some(malformed.sequence));
                }
                Err(error) => return Err(DamagedHistoryError::Log(error)),
            };
            if let Some(unreadable) = page
                .events
                .iter()
                .find(|envelope| SessionEvent::from_envelope(envelope).is_err())
            {
                return Ok(Some(i64::from(unreadable.sequence)));
            }
            if !page.has_more {
                return Ok(None);
            }
            after_sequence = page.next_sequence;
        }
    }
}

// The point a session damaged from `damaged_from_sequence` opens at, `None` when no event before
// it can be read.
fn read_last_good_point(
    reader: &Connection,
    session_id: &SessionId,
    damaged_from_sequence: i64,
) -> Result<Option<LastGoodPoint>, DamagedHistoryError> {
    let Some(damaged_from) = sequence_of(damaged_from_sequence) else {
        return Ok(None);
    };
    Ok(reader
        .prepare_cached(&SELECT_LAST_EVENT_BEFORE_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@before_sequence": damaged_from_sequence,
            },
            |row| {
                let last_sequence: i64 = row.get(0)?;
                let last_occurred_at = text_column(row, 1, WireInstant::try_from)?;
                Ok(
                    sequence_of(last_sequence).map(|last_sequence| LastGoodPoint {
                        last_sequence,
                        last_occurred_at,
                        damaged_from_sequence: damaged_from,
                    }),
                )
            },
        )
        .optional()?
        .flatten())
}

// A stored sequence as the point carries it; the log's sequences start at zero.
fn sequence_of(sequence: i64) -> Option<SafeInt<0>> {
    u64::try_from(sequence).ok().and_then(SafeInt::new)
}

#[cfg(test)]
mod tests;
