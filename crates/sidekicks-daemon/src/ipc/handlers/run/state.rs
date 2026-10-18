//! `agent.run.subscribe`: the state of every run in a session, the lead and each child, followed
//! from after the cursor a returning screen names, replaying what the log holds past it, or else
//! from the session's newest event. It carries each run state change and each rollback the log
//! records, and the provider's safety hold on a turn, which the log never records: a hold goes out
//! only once the stream has read every stored change, at the newest position read, so a screen
//! resuming from it skips no row. The stream reads its frames from the log at its cursor only once
//! the subscription's lane has credit and the connection has room, so nothing is dropped. A
//! session the daemon does not hold, or a cursor it cannot read, is refused before anything opens,
//! and a read that fails later ends the subscription with the failure.

use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize as _;
use serde_json::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::run::control::{
    AgentRunSubscribe, AgentRunSubscribeRequest, RunStateChangeEvent, RunStateStreamChange,
    RunStateStreamEvent, RunStateStreamFrame,
};
use sidekicks_contracts::session::event_cursor::{
    EventCursor, START_OF_LOG_POSITION, decode_event_cursor, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::row::TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
use sidekicks_contracts::transcript::run_facts::{RUN_STATE_EVENT_TYPES, RunStateEventType};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::log_service::{EventLogReadError, EventLogService, FollowStart};
use crate::ipc::handlers::run::safety_holds::{RunSafetyHolds, SafetyHoldsFollow};
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::ipc::stream::feed::{ChangeRecord, Feed};
use crate::ipc::stream::frame_batcher::{ChangeFeed, FrameBatcher};
use crate::session::run::stored_state_change::read_stored_run_state_change;
use crate::session::run::superseded::{StoredRollbackMismatchError, parse_stored_rollback};

/// The event types the stream carries: every state change the stored reader reads, and the
/// rollback. Read by type, so a page never fills with events the stream does not carry.
static RUN_STATE_STREAM_EVENT_TYPES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    RUN_STATE_EVENT_TYPES
        .iter()
        .filter(|event_type| **event_type != RunStateEventType::Queued)
        .map(|event_type| event_type.session_event_type().as_str())
        .chain([TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE])
        .collect()
});

/// Registers `agent.run.subscribe` over `log`, carrying the safety holds `holds` takes in. Refuses
/// a session the daemon does not hold `session.notFound` and a cursor it cannot read
/// `session.event.cursorUnresolvable`, opening nothing. Fails the start when the method is already
/// registered.
pub(crate) fn register_run_state_subscribe(
    registry: &mut MethodRegistryBuilder,
    log: Arc<EventLogService>,
    holds: Arc<RunSafetyHolds>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<AgentRunSubscribe, _>(
        move |request: AgentRunSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let log = Arc::clone(&log);
            let holds = Arc::clone(&holds);
            async move {
                let start = request
                    .after_cursor
                    .map_or(FollowStart::Newest, FollowStart::After);
                let cursor = log.read_follow_start(request.session_id, start).await?;
                let record = Arc::new(RunStateRecord::open(log, request.session_id, &holds));
                let feed: Box<dyn Feed<Emission = RunStateStreamFrame>> = Box::new(
                    ChangeFeed::new(FrameBatcher::new(record, cursor), |changes| {
                        RunStateStreamFrame { changes }
                    }),
                );
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Why a page of a run state stream could not be read.
#[derive(Debug, thiserror::Error)]
enum RunStateStreamError {
    /// The log could not be read.
    #[error(transparent)]
    Log(#[from] EventLogReadError),
    /// A stored state change does not read as its type's payload.
    #[error(transparent)]
    StateChange(#[from] SessionEventReadError),
    /// A stored state change does not read as the stream's transition.
    #[error("a stored run state change does not read as the stream's transition")]
    Transition(#[source] serde_json::Error),
    /// A stored rollback does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
}

impl From<DatabaseReadError> for RunStateStreamError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Log(error.into())
    }
}

/// What one read of the log gives: the stored changes, and, when the read reached the session's
/// head, the cursor a waiting hold goes out at.
struct RunStatePage {
    changes: Vec<RunStateStreamChange>,
    holds_cursor: Option<EventCursor>,
}

/// One session's log as a run state stream reads it, with the safety holds waiting for the stream;
/// the stream's change count is raised by both.
struct RunStateRecord {
    log: Arc<EventLogService>,
    session_id: SessionId,
    holds: SafetyHoldsFollow,
    change_count: watch::Sender<u64>,
    /// Raises the stream's count by each event the session's log commits.
    forwarding: JoinHandle<()>,
}

impl RunStateRecord {
    /// The record of `session_id`'s stream, following its holds in `holds` from now on.
    fn open(log: Arc<EventLogService>, session_id: SessionId, holds: &Arc<RunSafetyHolds>) -> Self {
        let change_count = watch::Sender::new(0);
        let mut log_count = log.change_count(&session_id);
        // Read before the task starts, so an event committed from now on is counted.
        let seen = *log_count.borrow_and_update();
        let forwarding = tokio::spawn(forward_log_changes(log_count, seen, change_count.clone()));
        Self {
            holds: holds.follow(session_id, change_count.clone()),
            log,
            session_id,
            change_count,
            forwarding,
        }
    }
}

impl Drop for RunStateRecord {
    fn drop(&mut self) {
        self.forwarding.abort();
    }
}

/// Raises `stream_count` by each change `log_count` signals after `seen`, until the log's signal
/// is gone.
async fn forward_log_changes(
    mut log_count: watch::Receiver<u64>,
    mut seen: u64,
    stream_count: watch::Sender<u64>,
) {
    while log_count.changed().await.is_ok() {
        let count = *log_count.borrow_and_update();
        stream_count.send_modify(|stream| *stream += count.saturating_sub(seen));
        seen = count;
    }
}

impl ChangeRecord for RunStateRecord {
    type Cursor = EventCursor;
    type Change = RunStateStreamChange;
    type Error = RunStateStreamError;

    fn read_after(
        &self,
        cursor: &EventCursor,
        max: usize,
    ) -> BoxFuture<'_, Result<Vec<RunStateStreamChange>, RunStateStreamError>> {
        let cursor = cursor.clone();
        async move {
            let after_position = decode_event_cursor(&cursor).map_err(EventLogReadError::from)?;
            let RunStatePage {
                mut changes,
                holds_cursor,
            } = self
                .log
                .read_stream_page(
                    self.session_id,
                    after_position,
                    max,
                    Some(RUN_STATE_STREAM_EVENT_TYPES.as_slice()),
                    move |_connection, _read_damaged_from_sequence, page| {
                        // Read before the events, so a page that reached it holds every change
                        // stored up to it, and a hold at it skips none.
                        let mut newest_read =
                            after_position.max(page.head.unwrap_or(START_OF_LOG_POSITION));
                        let has_reached_head = page.events.len() < max;
                        let mut changes = Vec::with_capacity(page.events.len());
                        for event in page.events {
                            let position = i64::from(event.sequence);
                            newest_read = newest_read.max(position);
                            if let Some(streamed) = run_state_stream_event_of(&event)? {
                                changes.push(RunStateStreamChange {
                                    cursor: encode_event_cursor(position)
                                        .map_err(EventLogReadError::from)?,
                                    event: streamed,
                                });
                            }
                        }
                        let holds_cursor = has_reached_head
                            .then(|| encode_event_cursor(newest_read))
                            .transpose()
                            .map_err(EventLogReadError::from)?;
                        Ok::<_, RunStateStreamError>(RunStatePage {
                            changes,
                            holds_cursor,
                        })
                    },
                )
                .await?;
            if let Some(holds_cursor) = holds_cursor {
                let room = max - changes.len();
                changes.extend(self.holds.take(room).into_iter().map(|hold| {
                    RunStateStreamChange {
                        cursor: holds_cursor.clone(),
                        event: RunStateStreamEvent::SafetyBuffering(hold),
                    }
                }));
            }
            Ok(changes)
        }
        .boxed()
    }

    fn cursor_of(change: &RunStateStreamChange) -> EventCursor {
        change.cursor.clone()
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.change_count.subscribe()
    }
}

/// What the stream carries for a stored event: a run's state change without its session, stamped
/// with when it happened, or a rollback as stored; nothing for any other event.
fn run_state_stream_event_of(
    event: &EventEnvelope,
) -> Result<Option<RunStateStreamEvent>, RunStateStreamError> {
    if event.event_type.as_str() == TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE {
        let rollback =
            parse_stored_rollback(&event.payload, &event.session_id, i64::from(event.sequence))?;
        return Ok(Some(RunStateStreamEvent::RolledBack(rollback)));
    }
    if read_stored_run_state_change(event)?.is_none() {
        return Ok(None);
    }
    let mut transition = event.payload.clone();
    transition.remove("sessionId");
    let timestamp =
        serde_json::to_value(&event.occurred_at).map_err(RunStateStreamError::Transition)?;
    transition.insert("timestamp".to_owned(), timestamp);
    let change = RunStateChangeEvent::deserialize(Value::Object(transition))
        .map_err(RunStateStreamError::Transition)?;
    Ok(Some(RunStateStreamEvent::StateChange(change)))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;

    use super::*;
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::events::log_service::EventLogAppendOptions;
    use crate::ipc::call_fixtures::{context, request, test_event_log};
    use crate::ipc::registry::{Dispatch as _, DispatchError, EncodedFeed, MethodRegistry, Reply};
    use crate::ipc::stream::feed::CreditGate;
    use crate::provider::port::run_state_publisher::RunStatePublisher as _;
    use crate::uuid_v7::mint_uuid_v7;

    /// Long enough for a frame that is coming to come, many windows over.
    const QUIET: Duration = Duration::from_millis(250);

    async fn append(log: &EventLogService, session_id: SessionId, event: &Value) {
        let event = serde_json::from_value(event.clone()).expect("the test writes a valid event");
        log.append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the append commits");
    }

    fn served(log: &Arc<EventLogService>, holds: &Arc<RunSafetyHolds>) -> MethodRegistry {
        let mut builder = MethodRegistryBuilder::new();
        register_run_state_subscribe(&mut builder, Arc::clone(log), Arc::clone(holds))
            .expect("the method registers");
        builder.freeze()
    }

    fn hold(session_id: SessionId, run_id: &str, active: bool) -> RunSafetyBufferingUpdatedPayload {
        serde_json::from_value(json!({
            "sessionId": session_id,
            "runId": run_id,
            "turnId": "turn-1",
            "active": active,
        }))
        .expect("the test writes a valid hold")
    }

    async fn next_frame(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Vec<Value> {
        let value = feed
            .next(gate)
            .await
            .expect("the log reads")
            .expect("the stream goes on");
        let frame: RunStateStreamFrame =
            serde_json::from_slice(&value.json).expect("the frame reads as its type");
        frame
            .changes
            .into_vec()
            .into_iter()
            .map(|change| serde_json::to_value(change).expect("a change writes"))
            .collect()
    }

    #[tokio::test]
    async fn a_hold_during_the_catch_up_goes_out_after_it_at_the_newest_position_read() {
        let database = TestDatabase::new();
        let log = test_event_log(&database).await;
        let holds = RunSafetyHolds::new();
        let session_id = test_session_id();
        let run_id = mint_uuid_v7().to_string();
        append(
            &log,
            session_id,
            &json!({
                "type": "session.pinned",
                "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
            }),
        )
        .await;
        for run_version in 1..=51 {
            append(
                &log,
                session_id,
                &json!({
                    "type": "agent.run.running",
                    "payload": {
                        "sessionId": session_id,
                        "runId": run_id,
                        "runVersion": run_version,
                        "previousState": "starting",
                        "newState": "running",
                    },
                }),
            )
            .await;
        }
        let first_cursor = encode_event_cursor(0).expect("a position has a cursor");
        let reply = served(&log, &holds)
            .dispatch(
                request(
                    AgentRunSubscribe::DESCRIPTOR.method,
                    &json!({ "sessionId": session_id, "afterCursor": first_cursor }),
                ),
                context(1),
            )
            .await;
        let Ok(Reply::Subscription { mut feed, .. }) = reply else {
            panic!("a held session's subscribe answers a subscription");
        };
        let gate = CreditGate::with_credit(0);
        assert!(tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err());

        // Two holds of one turn while the stream has read nothing: only the newest waits.
        holds.publish(hold(session_id, &run_id, true));
        holds.publish(hold(session_id, &run_id, false));
        gate.credit.add_permits(1);

        let first = next_frame(&mut feed, &gate).await;
        assert_eq!(
            first.len(),
            50,
            "a full page of stored changes leaves the hold waiting"
        );
        assert!(
            first
                .iter()
                .all(|change| change["event"]["newState"] == "running")
        );
        let last = next_frame(&mut feed, &gate).await;
        let newest_stored = json!(encode_event_cursor(51).expect("a position has a cursor"));
        assert_eq!(last.len(), 2);
        assert_eq!(last[0]["cursor"], newest_stored);
        assert_eq!(last[0]["event"]["runVersion"], 51);
        assert_eq!(
            last[1],
            json!({
                "cursor": newest_stored,
                "event": {
                    "sessionId": session_id,
                    "runId": run_id,
                    "turnId": "turn-1",
                    "active": false,
                },
            }),
            "the newest hold goes out after the stored changes, at the newest position read"
        );
    }

    #[tokio::test]
    async fn a_session_the_daemon_does_not_hold_is_refused_before_anything_opens() {
        let database = TestDatabase::new();
        let log = test_event_log(&database).await;
        let holds = RunSafetyHolds::new();
        let reply = served(&log, &holds)
            .dispatch(
                request(
                    AgentRunSubscribe::DESCRIPTOR.method,
                    &json!({ "sessionId": test_session_id() }),
                ),
                context(1),
            )
            .await;
        let Err(DispatchError::Refused(refusal)) = reply else {
            panic!("an unknown session is refused");
        };
        assert_eq!(refusal.code, RefusalCode::SessionNotFound);
    }
}
