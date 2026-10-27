use serde_json::{Value, json};

use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, TestCodexSession, turn_started,
};
use crate::provider::run::delivery::LateAppendableRow;

// An `error` frame of turn `turn-1` on [`TEST_THREAD`] on Codex's arm `kind`.
fn error_frame(kind: &str, will_retry: bool) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "error",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-1",
            "willRetry": will_retry,
            "error": {"message": "The server is busy.", "codexErrorInfo": kind},
        },
    })
}

// Kills: the retried request's row dropped, filed for an error Codex will not retry, or filed
// with a kind other than the arm's.
#[tokio::test]
async fn each_error_codex_retries_files_one_retried_request_on_the_turns_run() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    session.daemon_turn_bindings.open_on(binding_id);
    session.scripted.script.send(&turn_started("turn-1"));
    session.task.handle_next().await;
    let run_id = session
        .task
        .record
        .active_turn_run("turn-1")
        .expect("the turn's run opened");

    session
        .scripted
        .script
        .send(&error_frame("serverOverloaded", true));
    session.task.handle_next().await;
    session
        .scripted
        .script
        .send(&error_frame("internalServerError", false));
    session.task.handle_next().await;

    let retried: Vec<(String, Value)> = session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| {
            let Some(LateAppendableRow::UsageApiRequestRetried(payload)) = delivery.row else {
                return None;
            };
            Some((
                payload.run_id.expect("the row names its run").to_string(),
                serde_json::to_value(payload.error_kind).expect("an error kind serializes"),
            ))
        })
        .collect();
    assert_eq!(
        retried,
        [(run_id.to_string(), json!("overloaded"))],
        "one row for the retried error, none for the final one"
    );
}
