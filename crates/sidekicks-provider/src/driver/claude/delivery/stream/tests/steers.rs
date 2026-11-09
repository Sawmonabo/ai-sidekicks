//! Where a message Claude Code took lands among its run's deliveries.

use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{result, tool_call};
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::scripted::held_calls::{init, stand_in};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::port::run_host::test_host::{EngineCall, RecordedDelivery};
use crate::run::delivery::LateAppendableRow;

fn new_item() -> QueueItemId {
    QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id")
}

// Records `item` as written to the session's process for `run_id`, a steer when `is_steer`.
fn write(session: &ScriptedSession, run_id: RunId, item: QueueItemId, is_steer: bool) {
    session
        .start
        .prompts
        .lock()
        .expect("the prompts' lock holds")
        .record_written(session.session_id, run_id, &item.to_string(), is_steer);
}

// Claude Code's `started` state of the message written under `item`.
fn started(item: QueueItemId) -> Value {
    json!({
        "type": "command_lifecycle",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "command_uuid": item.to_string(),
        "state": "started",
    })
}

// Claude Code's replayed echo of the message written under `item`.
fn echo(item: QueueItemId) -> Value {
    json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "uuid": item.to_string(),
        "isReplay": true,
        "message": {"role": "user", "content": "Go on"},
    })
}

// The lead's reply `message_id`, in words.
fn reply(message_id: &str) -> Value {
    json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": "On it."}],
        },
    })
}

// The landings of the session's deliveries, as (message, turn number).
fn landings(session: &ScriptedSession) -> Vec<(QueueItemId, u64)> {
    session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "turnSteered")
        .filter_map(|delivery| Some((delivery.message_id?, delivery.steered_turn_number?.get())))
        .collect()
}

// The deliveries after the run's `nth` turn start (from 1), in order.
fn deliveries_after_start(
    session: &ScriptedSession,
    run_id: RunId,
    nth: usize,
) -> Vec<RecordedDelivery> {
    session
        .engine
        .calls()
        .into_iter()
        .skip_while({
            let mut seen = 0;
            move |call| {
                if matches!(call, EngineCall::StartTurn(started, _) if *started == run_id) {
                    seen += 1;
                }
                seen < nth
            }
        })
        .filter_map(|call| {
            let EngineCall::Deliver(delivery) = call else {
                return None;
            };
            Some(*delivery)
        })
        .collect()
}

// A steer taken mid-turn lands once, at its first sign, between the tool result before it and the
// reply after it; one kept past its turn's end lands right after the next turn's start; the
// opening's `started` lands nothing; of two written messages taken into one turn, the newer lands
// right after the turn's start, before its rows, and the older, which opens it, lands nothing; one
// kept past its turn's end lands in the turn a continue reopens, before that turn's rows. Killed
// by a `started` with no turn open dropped, by both signs landing, by the opening landed, by a
// turn's later message dropped and by a continue that leaves the kept message for a later turn.
#[tokio::test(start_paused = true)]
async fn a_claude_steer_lands_where_claude_code_took_it() {
    // Mid-turn: a tool result, the steer's echo, its `started`, a reply.
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let steer = new_item();
    write(&session, run_id, steer, true);
    session.frame(&init());
    session.frame(&tool_call("message-1", "call-1", "Read", None));
    session.frame(&stand_in("call-1", "read"));
    session.frame(&echo(steer));
    session.frame(&started(steer));
    session.frame(&reply("message-2"));
    session.frame(&result(&json!({})));
    settle().await;
    assert_eq!(landings(&session), [(steer, 1)]);
    let deliveries = session.engine.deliveries();
    let row_at = |is_row: fn(&LateAppendableRow) -> bool| {
        deliveries
            .iter()
            .position(|delivery| delivery.row.as_ref().is_some_and(is_row))
            .expect("the row is delivered")
    };
    let landed_at = deliveries
        .iter()
        .position(|delivery| delivery.kind == "turnSteered")
        .expect("the steer lands");
    let result_at = row_at(|row| matches!(row, LateAppendableRow::AgentToolCallCompleted(_)));
    let reply_at = row_at(|row| matches!(row, LateAppendableRow::AgentMessageSent(_)));
    assert!(
        result_at < landed_at && landed_at < reply_at,
        "{deliveries:?}"
    );

    // Kept past the turn's end: `result`, the steer's `started`, the next turn's `system/init`.
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let steer = new_item();
    write(&session, run_id, steer, true);
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    session.frame(&started(steer));
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    let after_second_start = deliveries_after_start(&session, run_id, 2);
    assert_eq!(
        after_second_start
            .first()
            .map(|delivery| (delivery.kind, delivery.message_id)),
        Some(("turnSteered", Some(steer))),
        "{after_second_start:?}"
    );
    assert_eq!(landings(&session), [(steer, 2)]);

    // The opening's `started` before its turn's `system/init`.
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let opening = new_item();
    write(&session, run_id, opening, false);
    session.frame(&started(opening));
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::StartTurn(run_id, Some(opening)))
    );
    assert_eq!(landings(&session), []);

    // Two written messages merged into one command: both echoed and `started` before the turn's
    // `system/init`.
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let (older, newer) = (new_item(), new_item());
    write(&session, run_id, older, false);
    write(&session, run_id, newer, false);
    session.frame(&echo(older));
    session.frame(&started(older));
    session.frame(&started(newer));
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::StartTurn(run_id, Some(older)))
    );
    // The older's echo may open the turn itself, so the newer lands before any row of the turn.
    let after_start = deliveries_after_start(&session, run_id, 1);
    let landed_at = after_start
        .iter()
        .position(|delivery| delivery.kind == "turnSteered")
        .expect("the newer lands");
    assert!(
        after_start[..landed_at]
            .iter()
            .all(|delivery| delivery.kind != "sessionRow"),
        "{after_start:?}"
    );
    assert_eq!(landings(&session), [(newer, 1)]);

    // Kept past the turn's end, then the turn continued: `result`, the steer's `started`, the
    // continue, a reply.
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let steer = new_item();
    write(&session, run_id, steer, true);
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    session.frame(&started(steer));
    settle().await;
    let first_turn = SafeInt::<1>::new(1).expect("1 is a turn number");
    session.stream.continue_turn(
        &ClaudeBoundRun {
            run_id,
            binding_id: binding_id("lead"),
        },
        first_turn,
        None,
    );
    session.frame(&reply("message-3"));
    settle().await;
    assert_eq!(landings(&session), [(steer, 1)]);
    let deliveries = session.engine.deliveries();
    let landed_at = deliveries
        .iter()
        .position(|delivery| delivery.kind == "turnSteered")
        .expect("the steer lands");
    let reply_at = deliveries
        .iter()
        .position(|delivery| {
            delivery
                .row
                .as_ref()
                .is_some_and(|row| matches!(row, LateAppendableRow::AgentMessageSent(_)))
        })
        .expect("the reply is delivered");
    assert!(landed_at < reply_at, "{deliveries:?}");
}
