//! The latest context reading of each session, as its driver publishes it, which feeds the ring
//! and the inspector's `Context` section alike. A session's reading goes once the session closes,
//! and one published after that is dropped.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionContextReading;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_provider::port::context_reading_publisher::ContextReadingPublisher;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};

use super::latest::LatestReadings;
use super::{ClosedSessions, ReadingFollowError, follow_closed_sessions, refuse_unknown_session};

/// Each session's latest context reading and its subscribers; the context readings' intake that
/// the daemon registers for the drivers.
pub struct ContextReadings {
    pool: Arc<DatabaseReadPool>,
    readings: Arc<LatestReadings<SessionId, SessionContextReading>>,
    closed: Arc<ClosedSessions>,
    // Lets a session's reading go once it closes; dropped with the readings.
    _session_closes: FollowerAttachment,
}

impl ContextReadings {
    /// Readings that hold none until a driver publishes one, reading sessions on `pool`, and
    /// letting a session's reading go once `followers` hears the session closed.
    pub fn new(pool: Arc<DatabaseReadPool>, followers: &Arc<SessionEventFollowers>) -> Self {
        let readings = Arc::new(LatestReadings::default());
        let closed = Arc::new(ClosedSessions::default());
        let released = Arc::clone(&readings);
        let session_closes = follow_closed_sessions(followers, &closed, move |session_id| {
            released.release(&session_id);
        });
        Self {
            pool,
            readings,
            closed,
            _session_closes: session_closes,
        }
    }

    /// Forgets `session_id`, which was purged, as closed.
    pub fn forget_purged_session(&self, session_id: SessionId) {
        self.closed.forget_purged(session_id);
    }

    /// Sends `session_id`'s held reading through `outlet` at once, if there is one, then each
    /// newer one, until the answered detach runs. Refused `session.notFound` for a session this
    /// daemon holds no row for, following nothing; fails when the session cannot be read.
    pub async fn follow(
        &self,
        session_id: SessionId,
        outlet: LatestValueOutlet<SessionContextReading>,
    ) -> Result<impl FnOnce() + Send + use<>, ReadingFollowError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                refuse_unknown_session(reader, &session_id)
            })
            .await?;
        Ok(self.readings.follow(session_id, outlet))
    }
}

impl ContextReadingPublisher for ContextReadings {
    fn publish_context_reading(&self, reading: SessionContextReading) {
        let session_id = reading.session_id;
        self.closed.publish_unless_closed(session_id, || {
            self.readings.publish(session_id, reading);
        });
    }
}
