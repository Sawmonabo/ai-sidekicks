use std::sync::Arc;

use serde_json::json;

use super::ChildRunLookup;
use crate::driver::codex::delivery::rows::test_row_run;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};

/// The refused helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The turn the helper is running as its run is refused.
const HELPER_TURN: &str = "helper-turn";

// A helper whose run the daemon refused stays bound to that ended run and has the turn it is
// running interrupted on its own conversation. Killed by a refusal that stops nothing, and by one
// that leaves the helper with no run, so its rows have no owner.
#[tokio::test]
async fn a_refused_helpers_running_turn_is_interrupted() {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let refused = session.engine.refuse_next_child_run();
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
    let ChildRunLookup::Started { run, .. } = session.task.record.child_run_on(HELPER_THREAD)
    else {
        panic!("the refused helper keeps its ended run");
    };
    assert_eq!(run.run_id, refused);
}
