use serde_json::{Value, json};

use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, TestCodexSession, turn_started,
};

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
    session.daemon_turn_bindings.open_on(binding_id.clone());
    session.scripted.script.send(&turn_started("turn-1"));
    session.task.handle_next().await;
    let run_id = session
        .task
        .record
        .active_turn_run("turn-1")
        .expect("the turn's run opened");
    session.open_epoch(binding_id, run_id);

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

    let reader = session.database.reader();
    let mut statement = reader
        .prepare(
            "SELECT run_id, json_extract(payload, '$.errorKind') FROM session_events
             WHERE type = 'usage.apiRequest.retried' ORDER BY sequence",
        )
        .expect("the query is valid");
    let retried: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the query runs")
        .collect::<Result<_, _>>()
        .expect("the rows read");
    assert_eq!(
        retried,
        [(run_id.text().as_str().to_owned(), "overloaded".to_owned())],
        "one row for the retried error, none for the final one"
    );
}
