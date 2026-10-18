//! `session.event.subscribe`: a session's events, caught up from after `afterCursor` (from the
//! start of its log when absent) and then followed, in batched frames, each change carrying its
//! cursor and, for an event of a run, the run stamp its transcript row carries. The stream reads
//! its frames from the log at its cursor only once the subscription's lane has credit and the
//! connection has room, so the catch-up goes at the connection's pace and nothing is dropped. A
//! session the daemon does not hold, or a cursor it cannot read, is refused before anything opens,
//! and a read that fails later ends the subscription with the failure.

use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::session::directory::SessionEventSubscribe;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, decode_event_cursor, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionEventSubscribeRequest, SessionStreamChange, SessionStreamFrame,
};
use tokio::sync::watch;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::log_service::{EventLogReadError, EventLogService, FollowStart};
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::ipc::stream::feed::{ChangeRecord, Feed};
use crate::ipc::stream::frame_batcher::{ChangeFeed, FrameBatcher};
use crate::transcript::turn_attribution::{
    RunTurnReads, SessionTurnAttribution, TurnAttributionError,
};

/// Registers `session.event.subscribe` over `log`. Refuses a session the daemon does not hold
/// `session.notFound` and a cursor it cannot read `session.event.cursorUnresolvable`, opening
/// nothing. Fails the start when the method is already registered.
pub(crate) fn register_session_event_subscribe(
    registry: &mut MethodRegistryBuilder,
    log: Arc<EventLogService>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionEventSubscribe, _>(
        move |request: SessionEventSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let log = Arc::clone(&log);
            async move {
                let start = request
                    .after_cursor
                    .map_or(FollowStart::StartOfLog, FollowStart::After);
                let cursor = log.read_follow_start(request.session_id, start).await?;
                let record = Arc::new(SessionEventRecord::new(log, request.session_id));
                let feed: Box<dyn Feed<Emission = SessionStreamFrame>> = Box::new(ChangeFeed::new(
                    FrameBatcher::new(record, cursor),
                    |changes| SessionStreamFrame { changes },
                ));
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Why a page of a session's event stream could not be read.
#[derive(Debug, thiserror::Error)]
enum SessionEventStreamError {
    /// The log could not be read.
    #[error(transparent)]
    Log(#[from] EventLogReadError),
    /// An event of a run could not be attributed to its turn.
    #[error(transparent)]
    Attribution(#[from] TurnAttributionError),
}

impl From<DatabaseReadError> for SessionEventStreamError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Log(error.into())
    }
}

/// One session's log as its event stream reads it, stamping each event of a run as its transcript
/// row is stamped.
struct SessionEventRecord {
    log: Arc<EventLogService>,
    session_id: SessionId,
    /// The stream's attribution, fed every page in order; it holds one fold per run until the
    /// run's terminal event.
    attribution: Arc<Mutex<SessionTurnAttribution>>,
}

impl SessionEventRecord {
    fn new(log: Arc<EventLogService>, session_id: SessionId) -> Self {
        Self {
            log,
            session_id,
            attribution: Arc::new(Mutex::new(SessionTurnAttribution::new(session_id))),
        }
    }
}

impl ChangeRecord for SessionEventRecord {
    type Cursor = EventCursor;
    type Change = SessionStreamChange;
    type Error = SessionEventStreamError;

    fn read_after(
        &self,
        cursor: &EventCursor,
        max: usize,
    ) -> BoxFuture<'_, Result<Vec<SessionStreamChange>, SessionEventStreamError>> {
        let cursor = cursor.clone();
        let attribution = Arc::clone(&self.attribution);
        async move {
            let after_position = decode_event_cursor(&cursor).map_err(EventLogReadError::from)?;
            self.log
                .read_stream_page(
                    self.session_id,
                    after_position,
                    max,
                    None,
                    move |connection, read_damaged_from_sequence, page| {
                        let reads = RunTurnReads::new(connection, read_damaged_from_sequence);
                        // Only this stream's reads take it, one at a time.
                        let mut attribution =
                            attribution.lock().unwrap_or_else(PoisonError::into_inner);
                        page.events
                            .into_iter()
                            .map(|event| {
                                let run_stamp = attribution
                                    .attribute(&reads, &event)?
                                    .map(|attributed| attributed.stamp);
                                let cursor = encode_event_cursor(i64::from(event.sequence))
                                    .map_err(EventLogReadError::from)?;
                                Ok(SessionStreamChange {
                                    cursor,
                                    event,
                                    run_stamp,
                                })
                            })
                            .collect()
                    },
                )
                .await
        }
        .boxed()
    }

    fn cursor_of(change: &SessionStreamChange) -> EventCursor {
        change.cursor.clone()
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.log.change_count(&self.session_id)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::method::Method as _;

    use super::*;
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::events::log_service::EventLogAppendOptions;
    use crate::ipc::call_fixtures::{context, request, test_event_log};
    use crate::ipc::registry::{Dispatch as _, EncodedFeed, Reply};
    use crate::ipc::stream::feed::CreditGate;

    /// Long enough for a frame that is coming to come, many windows over.
    const QUIET: Duration = Duration::from_millis(250);

    async fn pin(log: &EventLogService, session_id: SessionId) {
        let pinned = serde_json::from_value(json!({
            "type": "session.pinned",
            "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
        }))
        .expect("the test writes a session.pinned event");
        log.append(
            test_envelope(session_id, &pinned),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the append commits");
    }

    /// The sequences of the next frame's events.
    async fn next_sequences(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Vec<u64> {
        let value = feed
            .next(gate)
            .await
            .expect("the log reads")
            .expect("the stream goes on");
        let frame: SessionStreamFrame =
            serde_json::from_slice(&value.json).expect("the frame reads as its type");
        frame
            .changes
            .into_vec()
            .into_iter()
            .map(|change| change.event.sequence.get())
            .collect()
    }

    #[tokio::test]
    async fn the_catch_up_reads_only_while_the_lane_has_credit_then_follows_new_events() {
        let database = TestDatabase::new();
        let log = test_event_log(&database).await;
        let session_id = test_session_id();
        for _ in 0..60 {
            pin(&log, session_id).await;
        }
        let mut builder = MethodRegistryBuilder::new();
        register_session_event_subscribe(&mut builder, Arc::clone(&log))
            .expect("the method registers");
        let reply = builder
            .freeze()
            .dispatch(
                request(
                    SessionEventSubscribe::DESCRIPTOR.method,
                    &json!({ "sessionId": session_id }),
                ),
                context(1),
            )
            .await;
        let Ok(Reply::Subscription { mut feed, .. }) = reply else {
            panic!("a held session's subscribe answers a subscription");
        };

        let gate = CreditGate::with_credit(0);
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "nothing goes out while the lane has no credit"
        );
        gate.credit.add_permits(1);
        assert_eq!(
            next_sequences(&mut feed, &gate).await,
            (0..50).collect::<Vec<u64>>()
        );
        assert_eq!(
            next_sequences(&mut feed, &gate).await,
            (50..60).collect::<Vec<u64>>()
        );
        // Caught up: the stream is quiet until the log takes a new event, which it then follows.
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "the caught-up stream waits for the log"
        );
        let (followed, ()) = tokio::join!(next_sequences(&mut feed, &gate), pin(&log, session_id));
        assert_eq!(followed, [60]);
    }
}
