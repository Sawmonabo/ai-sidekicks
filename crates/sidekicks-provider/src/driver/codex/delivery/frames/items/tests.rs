use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::delivery::frames::CodexFrameDispatch;
use crate::driver::codex::delivery::memory::{CodexStartingTurn, CodexTurnOpening};
use crate::driver::codex::lifecycle::intake::routed_frames::{
    CodexRoutedFramesIntake, apply_codex_routed_frames,
};
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::run::steer::register_codex_steer;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession, turn_started};
use crate::driver::test_registry::new_message_id;
use crate::port::run_host::test_host::{EngineCall, RecordedDelivery};

// The members of an item frame of `item` on `turn_id` of [`TEST_THREAD`].
fn item_frame(turn_id: &str, item: &Value) -> Map<String, Value> {
    json!({"threadId": TEST_THREAD, "turnId": turn_id, "item": item})
        .as_object()
        .cloned()
        .expect("the frame is an object")
}

// A web search item `item_id`, a tool call with no command behind it.
fn tool_item(item_id: &str) -> Value {
    json!({"type": "webSearch", "id": item_id, "query": "steer order"})
}

// The `userMessage` echo of the message sent under `message_id`, as Codex writes it.
fn echo_item(message_id: QueueItemId) -> Value {
    json!({
        "type": "userMessage",
        "id": format!("item-{message_id}"),
        "clientId": message_id.to_string(),
        "content": [],
    })
}

// Whether `delivery` lands the message `message_id`.
fn is_landing_of(delivery: &RecordedDelivery, message_id: QueueItemId) -> bool {
    delivery.kind == "turnSteered" && delivery.message_id == Some(message_id)
}

// A steer registered on a live turn and echoed between two tool items of one batch lands at its
// echo, after the first item's rows and before the second's, under the turn's number, and the
// queue is told of it once, after the batch; an echo of a message no steer registered lands
// nothing. A start carrying two messages opens its turn on the first and lands the second right
// after the turn's start, before the turn's first item. Killed by the landing sent after the
// batch, by an unregistered echo landed, and by the start's second message dropped.
#[tokio::test]
async fn a_codex_steer_lands_in_frame_order() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    session.daemon_turn_bindings.open_on(binding_id.clone());
    session.scripted.script.send(&turn_started("turn-1"));
    session.task.handle_next().await;
    let run_id = session
        .task
        .record
        .active_turn_run("turn-1")
        .expect("the turn's run opened");
    let steer = new_message_id();
    let _registered = register_codex_steer(&mut session.task.record, run_id, None, steer)
        .expect("the live turn takes a steer");
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let mut dispatch = CodexFrameDispatch::default();

    let before_batch = session.engine.deliveries().len();
    for frame in [
        tool_item("search-a"),
        echo_item(steer),
        tool_item("search-b"),
    ] {
        let members = item_frame("turn-1", &frame);
        delivery
            .deliver_item_started(&mut session.task.record, &members)
            .await;
        delivery
            .deliver_item_completed(&mut session.task.record, &members, &mut dispatch)
            .await;
    }
    delivery
        .deliver_item_completed(
            &mut session.task.record,
            &item_frame("turn-1", &echo_item(new_message_id())),
            &mut dispatch,
        )
        .await;
    let task = &mut session.task;
    apply_codex_routed_frames(
        &CodexRoutedFramesIntake {
            ports: &task.ports,
            engine: &task.engine,
            run_routes: &task.run_routes,
            run_control: &task.run_control,
            config_forks: &task.calls.runs.config_forks,
            delivery: &task.calls.forks.delivery,
        },
        &mut task.record,
        CodexRoutedFrames {
            dispatches: vec![dispatch],
            ..CodexRoutedFrames::default()
        },
    )
    .await;

    let batch = session.engine.deliveries().split_off(before_batch);
    let landings: Vec<usize> = (0..batch.len())
        .filter(|&at| batch[at].kind == "turnSteered")
        .collect();
    let [landing] = landings[..] else {
        panic!("one landing in the batch: {batch:?}");
    };
    assert!(is_landing_of(&batch[landing], steer), "{batch:?}");
    assert_eq!(
        (
            batch[landing].binding_id.clone(),
            batch[landing].steered_turn_number.map(SafeInt::get),
        ),
        (Some(binding_id.clone()), Some(1))
    );
    let rows_of = |deliveries: &[RecordedDelivery]| {
        deliveries
            .iter()
            .filter(|delivery| delivery.kind == "sessionRow")
            .count()
    };
    assert!(
        rows_of(&batch[..landing]) > 0,
        "the first item's rows go first: {batch:?}"
    );
    assert!(
        rows_of(&batch[landing..]) > 0,
        "the second item's rows go after: {batch:?}"
    );
    assert_eq!(*lock(&session.queue.taken), vec![steer.to_string()]);

    // A start carrying two messages, as the start's record holds it, and its `turn/started`.
    let [opening, later] = [(); 2].map(|()| new_message_id());
    session
        .task
        .record
        .delivery
        .starting_turns
        .push_back(CodexStartingTurn {
            run_id,
            opening: Some(CodexTurnOpening {
                opening,
                later: vec![later],
            }),
        });
    let started = json!({"threadId": TEST_THREAD, "turn": {"id": "turn-2", "items": []}});
    delivery
        .deliver_turn_started(
            &mut session.task.record,
            started.as_object().expect("the frame is an object"),
        )
        .await;
    delivery
        .deliver_item_started(
            &mut session.task.record,
            &item_frame("turn-2", &tool_item("search-c")),
        )
        .await;

    let calls = session.engine.calls();
    let start_at = calls
        .iter()
        .position(|call| *call == EngineCall::StartTurn(run_id, Some(opening)))
        .expect("the turn starts on its first message");
    let after_start: Vec<&RecordedDelivery> = calls[start_at..]
        .iter()
        .filter_map(|call| {
            let EngineCall::Deliver(delivery) = call else {
                return None;
            };
            Some(&**delivery)
        })
        .collect();
    assert!(
        after_start
            .first()
            .is_some_and(|delivery| is_landing_of(delivery, later)
                && delivery.steered_turn_number.map(SafeInt::get) == Some(2)),
        "the start's second message lands first: {after_start:?}"
    );
    assert!(
        !after_start
            .iter()
            .any(|delivery| is_landing_of(delivery, opening)),
        "the opening never lands: {after_start:?}"
    );
    assert!(
        after_start
            .iter()
            .skip(1)
            .any(|delivery| delivery.kind == "sessionRow"),
        "the turn's first item follows: {after_start:?}"
    );
}
