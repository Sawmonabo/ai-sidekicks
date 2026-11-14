//! The held calls of the turns an undo cuts, stopped on the session's live process.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Map, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::held_calls::{Ending, held_call, logged_held_calls};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, hand_scripted_frame, settle,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{HeldCallsSettle, SettleHeldToolCallsParams};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::held_tool_calls::HeldToolCall;

use super::{STORED_CONVERSATION, closed_calls, holding_session, stopped_tasks};

// The params of an undo's settle of `session_id`'s `calls`, on a leg of no account or conversation
// the live settle reads.
fn undo_settle(session_id: SessionId, calls: Vec<HeldToolCall>) -> SettleHeldToolCallsParams {
    SettleHeldToolCallsParams {
        session_id,
        provider_account_id: ProviderAccountId::new("account-1".to_owned()).expect("an account id"),
        conversation: STORED_CONVERSATION.to_owned(),
        runtime_metadata: Map::new(),
        settle: HeldCallsSettle::Undo { calls },
    }
}

// Fails when an undo's settle leaves a cut call's task running on its server, its call open in the
// log, or still on the stream for the stopped ending Claude Code reports after the stop to close a
// second time. Mutations: the stream's take dropped, so the call stays held (the notification
// writes a second close); the call ended through `release` as stopped, which keeps it settled (the
// notification closes it again); the close not sent (no close by the settle's answer); the
// `stop_task` send dropped (no stop for task-A).
#[tokio::test(start_paused = true)]
async fn an_undo_ends_a_cut_held_call_stopped_and_it_never_closes_again() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, run_id, start) =
        holding_session(&fixture, &channel, &[("call-A", "task-A")]).await;
    let parts = fixture.driver.composed_parts().expect("composed");

    fixture
        .driver
        .settle_held_tool_calls(undo_settle(
            session_id,
            vec![held_call("call-A", "task-A", (run_id, "lead"), None, None)],
        ))
        .await
        .expect("the cut calls are settled");
    let closed_by_the_settle = closed_calls(&fixture);
    hand_scripted_frame(
        &*start.listener,
        &parts.run_start.routes,
        session_id,
        &json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": "task-A",
            "tool_use_id": "call-A",
            "status": "stopped",
        }),
    );
    settle().await;

    assert_eq!(stopped_tasks(&channel), ["task-A"]);
    let stopped = || {
        (
            "call-A".to_owned(),
            Ending::Failed(Some(ToolCallEndCause::Stopped)),
            None,
        )
    };
    assert_eq!(closed_by_the_settle, [stopped()]);
    assert_eq!(closed_calls(&fixture), [stopped()]);
}

// Fails when an undo's settle of a session no process runs answers or writes anything: it refuses
// as no live session. Mutation: the undo settled at rest instead (call-1 closed from the log, and
// the settle answers).
#[tokio::test(start_paused = true)]
async fn an_undo_settle_with_no_live_process_fails() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account, STORED_CONVERSATION, Map::new());
    let call = held_call("call-1", "task-1", (new_run_id(), "binding-1"), None, None);
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(vec![call.clone()], &fixture.engine))
        .expect("the read registers once");

    let settled = fixture
        .driver
        .settle_held_tool_calls(undo_settle(session_id, vec![call]))
        .await;
    settle().await;

    assert!(
        matches!(
            &settled,
            Err(DriverError::Refused(refusal)) if refusal.code == RefusalCode::ProviderUnavailable
        ),
        "{settled:?}"
    );
    assert_eq!(closed_calls(&fixture), []);
}

// How Claude Code answers the first of an undo's stops.
#[derive(Clone, Copy, Debug)]
enum FirstStop {
    Refused,
    Unanswered,
}

// An undo's settle whose stop of one task Claude Code refuses, or does not answer within the
// bound, fails naming that task and leaves its call open, while the call whose stop was taken
// closes stopped. Mutations: a refused or unanswered stop read as taken (call-A closes and the
// settle answers), and every close held back by one failed stop (call-B stays open).
#[rstest]
#[case::refused(FirstStop::Refused)]
#[case::unanswered(FirstStop::Unanswered)]
#[tokio::test(start_paused = true)]
async fn an_undo_whose_stop_is_not_taken_fails_and_leaves_that_call_open(
    #[case] first_stop: FirstStop,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, run_id, _start) = holding_session(
        &fixture,
        &channel,
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    let _held = match first_stop {
        FirstStop::Refused => {
            channel.answer("stop_task", ScriptedAnswer::Refused);
            None
        }
        FirstStop::Unanswered => Some(channel.hold_next_control("stop_task")),
    };

    let settled = fixture
        .driver
        .settle_held_tool_calls(undo_settle(
            session_id,
            vec![
                held_call("call-A", "task-A", (run_id, "lead"), None, None),
                held_call("call-B", "task-B", (run_id, "lead"), None, None),
            ],
        ))
        .await;
    settle().await;

    match &settled {
        Err(DriverError::Internal(failure)) => {
            assert!(failure.to_string().contains("task-A"), "{failure}");
            assert!(!failure.to_string().contains("task-B"), "{failure}");
        }
        other => panic!("expected the settle to fail naming task-A, got {other:?}"),
    }
    assert_eq!(stopped_tasks(&channel), ["task-A", "task-B"]);
    assert_eq!(
        closed_calls(&fixture),
        [(
            "call-B".to_owned(),
            Ending::Failed(Some(ToolCallEndCause::Stopped)),
            None,
        )]
    );
}
