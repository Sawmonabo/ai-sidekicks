//! A session whose history cannot be rebuilt whole. Its last good point is every event before the
//! first one that cannot be read: a row that is not a well-formed event, an event its registered
//! shape refuses, or one the projections' fold cannot take. The session's projections are rebuilt
//! through that point and it opens there, read-only. The damaged rows are never moved, rewritten
//! or deleted.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::events::session::read::SessionLogReadError;
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::recovery::projection_rebuild::{
    ProjectionFailure, ProjectionRebuildError, ProjectionRebuildRequest, ProjectionRebuildService,
    REBUILD_PAGE_SIZE,
};
use crate::recovery::status::LastGoodPoint;
use crate::session::service::{
    EventsReadAfterSequenceRequest, SessionService, SessionServiceError,
};

/// The statements damaged history's own reads run: the last event before a damaged one.
#[expect(dead_code, reason = "the daemon's start")]
pub(crate) const DAMAGED_HISTORY_STATEMENT_CAPACITY: usize = 1;

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

/// What damaged history reads and rebuilds through.
pub(crate) struct DamagedHistoryDeps {
    /// The reads of a session's last good point.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The pages of a session's log, read for its first unreadable event.
    pub(crate) session_events: Arc<SessionService>,
    /// The rebuilds through a last good point.
    pub(crate) projection_rebuild: Arc<ProjectionRebuildService>,
}

/// Finds a damaged session's last good point and rebuilds its projections through it.
pub(crate) struct DamagedHistory {
    deps: DamagedHistoryDeps,
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
        Self { deps }
    }

    /// Rebuilds the session's projections through its last good point after `failure` stopped its
    /// rebuild, and answers the point: the first event that cannot be read or folded, moved back
    /// to an earlier event that still contradicts the fold. `None` when no event before it can be
    /// read. Fails with the store's own failures as they come.
    pub(crate) async fn rebuild_through_last_good_point(
        &self,
        failure: &ProjectionFailure,
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
                        stop: None,
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
