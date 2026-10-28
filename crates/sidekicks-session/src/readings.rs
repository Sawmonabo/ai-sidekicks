//! The latest readings the drivers publish, each kept until its run or session ends: a session's
//! context reading and a run's turn readings. A subscriber reads the held reading at once and then
//! only the newest after each change, so a slow one never reads a queue of stale readings.

pub mod context;
mod latest;
pub mod turn;

use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};

use crate::directory::lookups::session_exists;

/// Why a subscriber to a reading could not be followed.
#[derive(Debug, thiserror::Error)]
pub enum ReadingFollowError {
    /// The session or the run is not one this daemon holds (`session.notFound`,
    /// `agent.run.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read of the session or the run.
    #[error("the session or run a reading follows could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<ReadingFollowError> for HandlerError {
    /// A refusal answers by its code; any other failure is a fault in the daemon.
    fn from(error: ReadingFollowError) -> Self {
        match error {
            ReadingFollowError::Refused(refusal) => Self::Refused(refusal),
            fault @ (ReadingFollowError::Read(_) | ReadingFollowError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Refuses `session.notFound` for a session with no directory row, read on `reader`; fails when
/// SQLite refuses the read.
fn refuse_unknown_session(
    reader: &Connection,
    session_id: &SessionId,
) -> Result<(), ReadingFollowError> {
    if session_exists(reader, session_id)? {
        Ok(())
    } else {
        Err(session_not_found(session_id).into())
    }
}

/// Calls `release` with each session whose close `followers` hears from now on, until the answered
/// attachment drops. It runs on the log writer's pump, so `release` only does quick work.
fn follow_closed_sessions(
    followers: &Arc<SessionEventFollowers>,
    release: impl Fn(SessionId) + Send + Sync + 'static,
) -> FollowerAttachment {
    followers.follow_all(move |event| {
        if event.envelope.event_type() == SessionEventType::SessionClosed {
            release(event.envelope.session_id());
        }
        Ok(())
    })
}
