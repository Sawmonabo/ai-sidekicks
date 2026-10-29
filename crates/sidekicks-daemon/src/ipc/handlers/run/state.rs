//! `agent.run.subscribe`: the state of every run in a session, the lead and each child, followed
//! from after the cursor a returning screen names, replaying what the log holds past it, or else
//! from the session's newest event. It carries each run state change and each rollback the log
//! records, and the provider's safety hold on a turn, which the log never records: a hold goes out
//! only once the stream has read every stored change, at the newest position read, so a screen
//! resuming from it skips no row; a hold on when the stream opens goes out the same way. The stream
//! reads its first frame when the call is taken and every later one from the log at its cursor
//! only once the subscription's lane has credit and the connection has room, so nothing is
//! dropped. A session the daemon does not hold, a cursor it cannot read, or a first frame that
//! cannot be read is refused before anything opens, and a read that fails later ends the
//! subscription with the failure.

use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::run::control::{
    AgentRunSubscribe, AgentRunSubscribeRequest, RunFailedStateChangeMembers,
    RunInterruptedStateChangeMembers, RunStateChangeEvent, RunStateChangeMembers,
    RunStateStreamChange, RunStateStreamEvent, RunStateStreamFrame, RunStoppedStateChangeMembers,
};
use sidekicks_contracts::session::event_cursor::{
    EventCursor, START_OF_LOG_POSITION, decode_event_cursor, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::run_facts::{RUN_STATE_EVENT_TYPES, RunStateEventType};
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::{ChangeRecord, Feed, RecordPage};
use sidekicks_ipc::stream::frame_batcher::ChangeFeed;
use sidekicks_session::run::stored_state_change::{
    StoredRunStateChange, read_stored_run_state_change,
};
use sidekicks_session::run::superseded::{StoredRollbackMismatchError, parse_stored_rollback};
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::log_service::{EventLogReadError, EventLogService, FollowStart};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::ipc::handlers::run::safety_holds::{RunSafetyHolds, SafetyHoldsFollow};

/// The type of a stored rollback, which the stream carries beside the state changes.
const ROLLBACK_EVENT_TYPE: &str = SessionEventType::AgentRunRolledBack.as_str();

/// The event types the stream carries: every state change the stored reader reads, and the
/// rollback. Read by type, so a page never fills with events the stream does not carry.
static RUN_STATE_STREAM_EVENT_TYPES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    RUN_STATE_EVENT_TYPES
        .iter()
        .filter(|event_type| **event_type != RunStateEventType::Queued)
        .map(|event_type| event_type.session_event_type().as_str())
        .chain([ROLLBACK_EVENT_TYPE])
        .collect()
});

/// Registers `agent.run.subscribe` over `log`, carrying the safety holds `holds` takes in. Refuses
/// a session the daemon does not hold `session.notFound` and a cursor it cannot read
/// `session.event.cursorUnresolvable`, and fails the call when its first page cannot be read, each
/// opening nothing. Fails the start when the method is already registered.
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
                    ChangeFeed::open(record, cursor, |changes| RunStateStreamFrame { changes })
                        .await?,
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
    /// A stored event's `occurredAt` does not read as an instant.
    #[error("a stored run state change's occurredAt does not read as an instant")]
    Timestamp(#[from] NotAnInstant),
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
    // After the last event read, or the head once the read reached it.
    read_through: Option<EventCursor>,
    has_reached_head: bool,
}

/// One session's log as a run state stream reads it, with the safety holds waiting for the stream;
/// the stream's change count is raised by both.
struct RunStateRecord {
    log: Arc<EventLogService>,
    session_id: SessionId,
    holds: SafetyHoldsFollow,
    change_count: watch::Receiver<u64>,
    /// Raises the stream's count by each event the session's log commits and each hold that comes,
    /// and ends the count once the log's signal is gone.
    forwarding: JoinHandle<()>,
}

impl RunStateRecord {
    /// The record of `session_id`'s stream, following its holds in `holds` from now on.
    fn open(log: Arc<EventLogService>, session_id: SessionId, holds: &Arc<RunSafetyHolds>) -> Self {
        let (stream_count, change_count) = watch::channel(0);
        let holds = holds.follow(session_id);
        let forwarding = tokio::spawn(forward_changes(
            log.change_count(&session_id),
            holds.change_count(),
            stream_count,
        ));
        Self {
            log,
            session_id,
            holds,
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

/// Raises `stream_count` by each change `log_count` and `hold_count` signal from now on, and ends,
/// dropping the stream's one sender, once either signal is gone.
async fn forward_changes(
    mut log_count: watch::Receiver<u64>,
    mut hold_count: watch::Receiver<u64>,
    stream_count: watch::Sender<u64>,
) {
    // Read before the first wait, so a change from now on is counted.
    let mut seen_log = *log_count.borrow_and_update();
    let mut seen_holds = *hold_count.borrow_and_update();
    loop {
        tokio::select! {
            changed = log_count.changed() => {
                if changed.is_err() {
                    return;
                }
                let count = *log_count.borrow_and_update();
                stream_count.send_modify(|stream| *stream += count.saturating_sub(seen_log));
                seen_log = count;
            }
            changed = hold_count.changed() => {
                if changed.is_err() {
                    return;
                }
                let count = *hold_count.borrow_and_update();
                stream_count.send_modify(|stream| *stream += count.saturating_sub(seen_holds));
                seen_holds = count;
            }
        }
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
    ) -> BoxFuture<'_, Result<RecordPage<EventCursor, RunStateStreamChange>, RunStateStreamError>>
    {
        let cursor = cursor.clone();
        async move {
            let after_position = decode_event_cursor(&cursor).map_err(EventLogReadError::from)?;
            let RunStatePage {
                mut changes,
                holds_cursor,
                read_through,
                has_reached_head,
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
                        let mut last_read = None;
                        for event in page.events {
                            let position = i64::from(event.sequence);
                            newest_read = newest_read.max(position);
                            last_read = Some(position);
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
                        let read_through = match &holds_cursor {
                            Some(holds_cursor) => Some(holds_cursor.clone()),
                            None => last_read
                                .map(encode_event_cursor)
                                .transpose()
                                .map_err(EventLogReadError::from)?,
                        };
                        Ok::<_, RunStateStreamError>(RunStatePage {
                            changes,
                            holds_cursor,
                            read_through,
                            has_reached_head,
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
            // A run's state changes are small, so a read is cut by its count alone: the log's
            // short of its head, or the holds' past the frame.
            Ok(RecordPage {
                is_cut_short: !has_reached_head || changes.len() == max,
                changes,
                read_through,
            })
        }
        .boxed()
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.change_count.clone()
    }

    fn is_store_closed(error: &RunStateStreamError) -> bool {
        match error {
            RunStateStreamError::Log(error) => error.is_pool_closed(),
            RunStateStreamError::StateChange(_)
            | RunStateStreamError::Timestamp(_)
            | RunStateStreamError::Rollback(_) => false,
        }
    }
}

/// What the stream carries for a stored event: a run's state change without its session, stamped
/// with when it happened, or a rollback as stored; nothing for any other event.
fn run_state_stream_event_of(
    event: &EventEnvelope,
) -> Result<Option<RunStateStreamEvent>, RunStateStreamError> {
    if event.event_type.as_str() == ROLLBACK_EVENT_TYPE {
        let rollback =
            parse_stored_rollback(&event.payload, &event.session_id, i64::from(event.sequence))?;
        return Ok(Some(RunStateStreamEvent::RolledBack(rollback)));
    }
    let Some(change) = read_stored_run_state_change(event.event_type.as_str(), &event.payload)?
    else {
        return Ok(None);
    };
    let timestamp = WireInstant::try_from(event.occurred_at.as_str().to_owned())?;
    Ok(Some(RunStateStreamEvent::StateChange(
        run_state_change_event_of(change, timestamp),
    )))
}

/// `change` as the stream carries it, without its session, stamped with `timestamp`.
fn run_state_change_event_of(
    change: StoredRunStateChange,
    timestamp: WireInstant,
) -> RunStateChangeEvent {
    /// The members a state change carries outside `interrupted`, `stopped` and `failed`.
    macro_rules! members {
        ($payload:ident, $execution_posture:expr, $intended_close:expr) => {
            RunStateChangeMembers {
                run_id: $payload.run_id,
                run_version: $payload.run_version,
                previous_state: $payload.previous_state,
                failure_category: $payload.failure_category,
                recovery_condition: $payload.recovery_condition,
                provider_failure_detail: None,
                intended_close: $intended_close,
                execution_posture: $execution_posture,
                failure_cause: None,
                process_exit: None,
                trigger: None,
                timestamp,
            }
        };
    }
    match change {
        StoredRunStateChange::Starting(payload) => {
            RunStateChangeEvent::Starting(members!(payload, None, None))
        }
        StoredRunStateChange::Running(payload) => {
            RunStateChangeEvent::Running(members!(payload, payload.execution_posture, None))
        }
        StoredRunStateChange::WaitingForApproval(payload) => {
            RunStateChangeEvent::WaitingForApproval(members!(payload, None, None))
        }
        StoredRunStateChange::WaitingForInput(payload) => {
            RunStateChangeEvent::WaitingForInput(members!(payload, None, None))
        }
        StoredRunStateChange::Pausing(payload) => {
            RunStateChangeEvent::Pausing(members!(payload, None, None))
        }
        StoredRunStateChange::Paused(payload) => {
            RunStateChangeEvent::Paused(members!(payload, None, None))
        }
        StoredRunStateChange::Completed(payload) => {
            RunStateChangeEvent::Completed(members!(payload, None, payload.intended_close))
        }
        StoredRunStateChange::Interrupted(payload) => {
            RunStateChangeEvent::Interrupted(RunInterruptedStateChangeMembers {
                run_id: payload.run_id,
                run_version: payload.run_version,
                previous_state: payload.previous_state,
                failure_category: payload.failure_category,
                recovery_condition: payload.recovery_condition,
                provider_failure_detail: None,
                intended_close: payload.intended_close,
                execution_posture: None,
                failure_cause: None,
                process_exit: None,
                trigger: payload.trigger,
                timestamp,
            })
        }
        StoredRunStateChange::Stopped(payload) => {
            RunStateChangeEvent::Stopped(RunStoppedStateChangeMembers {
                run_id: payload.run_id,
                run_version: payload.run_version,
                previous_state: payload.previous_state,
                failure_category: payload.failure_category,
                recovery_condition: payload.recovery_condition,
                provider_failure_detail: None,
                intended_close: payload.intended_close,
                execution_posture: None,
                failure_cause: None,
                process_exit: None,
                trigger: payload.trigger,
                timestamp,
            })
        }
        StoredRunStateChange::Failed(payload) => {
            RunStateChangeEvent::Failed(RunFailedStateChangeMembers {
                run_id: payload.run_id,
                run_version: payload.run_version,
                previous_state: payload.previous_state,
                failure_category: payload.failure_category,
                recovery_condition: payload.recovery_condition,
                provider_failure_detail: payload.provider_failure_detail,
                intended_close: payload.intended_close,
                execution_posture: None,
                failure_cause: payload.failure_cause,
                process_exit: payload.process_exit,
                trigger: None,
                timestamp,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch as _, DispatchError, EncodedFeed, MethodRegistry, Reply,
    };
    use sidekicks_ipc::stream::feed::CreditGate;
    use sidekicks_provider::port::run_state_publisher::RunStatePublisher as _;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::events::log_service::EventLogAppendOptions;
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::*;
    use crate::daemon::schema::schema_parts;

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

    async fn pin(log: &EventLogService, session_id: SessionId) {
        append(
            log,
            session_id,
            &json!({
                "type": "session.pinned",
                "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
            }),
        )
        .await;
    }

    fn served(log: &Arc<EventLogService>, holds: &Arc<RunSafetyHolds>) -> MethodRegistry {
        let mut builder = MethodRegistryBuilder::new();
        register_run_state_subscribe(&mut builder, Arc::clone(log), Arc::clone(holds))
            .expect("the method registers");
        builder.freeze()
    }

    fn hold(
        session_id: SessionId,
        run_id: &str,
        turn_id: &str,
        active: bool,
    ) -> RunSafetyBufferingUpdatedPayload {
        serde_json::from_value(json!({
            "sessionId": session_id,
            "runId": run_id,
            "turnId": turn_id,
            "active": active,
        }))
        .expect("the test writes a valid hold")
    }

    async fn subscribe(
        registry: &MethodRegistry,
        session_id: SessionId,
        after_cursor: Option<EventCursor>,
    ) -> Box<dyn EncodedFeed> {
        let params = match after_cursor {
            Some(cursor) => json!({ "sessionId": session_id, "afterCursor": cursor }),
            None => json!({ "sessionId": session_id }),
        };
        let reply = registry
            .dispatch(
                request(AgentRunSubscribe::DESCRIPTOR.method, Some(&params)),
                context(1),
            )
            .await;
        let Ok(Reply::Subscription { feed, .. }) = reply else {
            panic!("a held session's subscribe answers a subscription");
        };
        feed
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
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await.service;
        let holds = RunSafetyHolds::new();
        let session_id = test_session_id();
        let run_id = mint_uuid_v7().to_string();
        pin(&log, session_id).await;
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
        // An event the stream does not carry, so the newest position read is past its last change.
        pin(&log, session_id).await;
        let first_cursor = encode_event_cursor(0).expect("a position has a cursor");
        let mut feed = subscribe(&served(&log, &holds), session_id, Some(first_cursor)).await;
        let gate = CreditGate::with_credit(0);
        assert!(tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err());

        // Two holds of one run while the stream has read nothing: only the newest waits.
        holds.publish(hold(session_id, &run_id, "turn-1", true));
        holds.publish(hold(session_id, &run_id, "turn-1", false));
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
        assert_eq!(last.len(), 2);
        assert_eq!(
            last[0]["cursor"],
            json!(encode_event_cursor(51).expect("a position has a cursor"))
        );
        assert_eq!(last[0]["event"]["runVersion"], 51);
        assert_eq!(
            last[1],
            json!({
                "cursor": encode_event_cursor(52).expect("a position has a cursor"),
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
    async fn a_stream_opened_during_a_held_turn_starts_with_the_hold() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await.service;
        let holds = RunSafetyHolds::new();
        let session_id = test_session_id();
        let (held_run, released_run) = (mint_uuid_v7().to_string(), mint_uuid_v7().to_string());
        pin(&log, session_id).await;
        holds.publish(hold(session_id, &held_run, "turn-1", true));
        holds.publish(hold(session_id, &held_run, "turn-2", true));
        holds.publish(hold(session_id, &released_run, "turn-1", true));
        holds.publish(hold(session_id, &released_run, "turn-1", false));

        let mut feed = subscribe(&served(&log, &holds), session_id, None).await;
        let opened =
            tokio::time::timeout(QUIET, next_frame(&mut feed, &CreditGate::with_credit(1)))
                .await
                .expect("the hold goes out when the stream opens");
        assert_eq!(
            opened,
            [json!({
                "cursor": encode_event_cursor(0).expect("a position has a cursor"),
                "event": {
                    "sessionId": session_id,
                    "runId": held_run,
                    "turnId": "turn-2",
                    "active": true,
                },
            })],
            "only the hold still on goes out, its run's newest, at the session's newest position"
        );
    }

    #[rstest]
    #[case::unknown_session(false, None, RefusalCode::SessionNotFound)]
    #[case::cursor_past_the_head(true, Some(1), RefusalCode::SessionEventCursorUnresolvable)]
    #[tokio::test]
    async fn a_session_or_cursor_the_daemon_cannot_follow_is_refused_before_anything_opens(
        #[case] has_events: bool,
        #[case] after_position: Option<i64>,
        #[case] refused_with: RefusalCode,
    ) {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await.service;
        let holds = RunSafetyHolds::new();
        let session_id = test_session_id();
        if has_events {
            pin(&log, session_id).await;
        }
        let mut params = json!({ "sessionId": session_id });
        if let Some(position) = after_position {
            params["afterCursor"] = json!(encode_event_cursor(position).expect("a cursor"));
        }
        let reply = served(&log, &holds)
            .dispatch(
                request(AgentRunSubscribe::DESCRIPTOR.method, Some(&params)),
                context(1),
            )
            .await;
        let Err(DispatchError::Refused(refusal)) = reply else {
            panic!("the subscribe is refused");
        };
        assert_eq!(refusal.code, refused_with);
        assert_eq!(
            holds.follow_count(&session_id),
            0,
            "no stream follows holds"
        );
    }
}
