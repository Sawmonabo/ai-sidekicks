use std::sync::Arc;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::ChildRunLookup;
use crate::driver::codex::delivery::rows::test_row_run;
use crate::driver::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::RunSetupRefusal;

/// The refused helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The turn the helper is running as its run is refused.
const HELPER_TURN: &str = "helper-turn";

// A helper whose run the daemon refused stays bound to that ended run, has the turn it is running
// interrupted on its own conversation, and has its next tool call denied with the refusal's
// sentence. Killed by a refusal that stops nothing, by one that leaves the helper with no run, so
// its rows have no owner, and by a stop that drops the refusal's reason.
#[tokio::test]
async fn a_refused_helpers_running_turn_is_interrupted() {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let refusal = RunSetupRefusal {
        cause: "the test's gate refuses the run".to_owned(),
        is_posture_rejection: true,
    };
    let refused = session.engine.refuse_next_child_run(refusal.clone());
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, "call-1", &lead);

    delivery
        .start_child(
            &mut session.task.record,
            HELPER_THREAD,
            TEST_THREAD,
            HELPER_THREAD,
        )
        .await;

    let list = session.scripted.script.next_sent().await;
    assert_eq!(list["method"], "thread/turns/list");
    assert_eq!(list["params"]["threadId"], HELPER_THREAD);
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": list["id"],
        "result": {"data": [{"id": HELPER_TURN, "status": "inProgress"}]},
    }));
    let interrupt = session.scripted.script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": HELPER_THREAD, "turnId": HELPER_TURN})
    );
    session.scripted.script.answer(&interrupt, &json!({}));
    let ChildRunLookup::Bound { run, .. } = session.task.record.child_run_on(HELPER_THREAD) else {
        panic!("the refused helper keeps its ended run");
    };
    assert_eq!(run.run_id, refused);
    let helper_call = CodexHookInput {
        event: CodexHookEvent::PreToolUse,
        thread_id: HELPER_THREAD.to_owned(),
        session_id: None,
        turn_id: None,
        tool_name: None,
        tool_use_id: None,
        tool_input: None,
        tool_response: None,
        cwd: None,
    };
    let answer = delivery
        .dependencies
        .stopped_helpers
        .answer(&helper_call, &CancellationToken::new())
        .await
        .expect("the stopped helpers never fail");
    assert_eq!(
        answer,
        Some(CodexHookAnswer::Deny {
            reason: HelperStopReason::SetupRefused { refusal }.sentence(),
        })
    );
}
