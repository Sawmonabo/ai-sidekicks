//! The latest readings the drivers publish, each kept until its run or session ends: a session's
//! context reading and a run's turn readings. A subscriber reads the held reading at once and then
//! only the newest after each change, so a slow one never reads a queue of stale readings. A
//! reading published after its session closed is dropped, the closed sessions kept until purged.

pub mod context;
mod latest;
pub mod turn;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};

use crate::directory::lookups::session_exists;

/// The statements the readings prepare on the shared read pool: a session's row and a run's state.
pub const READINGS_STATEMENT_CAPACITY: usize = 2;

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

/// The sessions whose close a reading heard, each kept until the session is purged, so a reading
/// a driver publishes after its session closed is dropped rather than held for the daemon's life.
#[derive(Default)]
struct ClosedSessions {
    closed: Mutex<HashSet<SessionId>>,
}

impl ClosedSessions {
    /// Runs `publish` unless `session_id` closed; a close heard meanwhile waits for it, so its
    /// release drops what it held.
    fn publish_unless_closed(&self, session_id: SessionId, publish: impl FnOnce()) {
        let closed = lock(&self.closed);
        if !closed.contains(&session_id) {
            publish();
        }
    }

    /// Forgets `session_id`, which was purged.
    fn forget_purged(&self, session_id: SessionId) {
        lock(&self.closed).remove(&session_id);
    }
}

/// Marks each session whose close `followers` hears from now on in `closed` and calls `release`
/// with it, until the answered attachment drops. It runs on the log writer's pump, so `release`
/// only does quick work.
fn follow_closed_sessions(
    followers: &Arc<SessionEventFollowers>,
    closed: &Arc<ClosedSessions>,
    release: impl Fn(SessionId) + Send + Sync + 'static,
) -> FollowerAttachment {
    let closed = Arc::clone(closed);
    followers.follow_all(move |event| {
        if event.envelope.event_type() == SessionEventType::SessionClosed {
            let session_id = event.envelope.session_id();
            let mut closed = lock(&closed.closed);
            closed.insert(session_id);
            release(session_id);
        }
        Ok(())
    })
}
