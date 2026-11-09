use std::sync::Arc;

use rstest::rstest;
use serde_json::{Map, Value, json};

use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, turn_completed, turn_started,
};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::LateAppendableRow;
use crate::run::state_entry::RunStateEntry;

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

// A helper stopped at its token limit has each turn it starts later interrupted on its own
// conversation, while a helper never stopped runs its turn. Kills: a stopped helper that runs its
// next turn past its limit, and an interrupt sent to a helper never stopped.
#[tokio::test]
async fn a_helper_stopped_at_its_limit_has_its_next_turn_interrupted_at_its_start() {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let started = |thread_id: &str, turn_id: &str| -> Map<String, Value> {
        let frame = json!({"threadId": thread_id, "turn": {"id": turn_id, "items": []}});
        frame.as_object().cloned().expect("the frame is an object")
    };

    delivery
        .deliver_turn_started(&mut session.task.record, &started("other-helper", "turn-a"))
        .await;
    delivery.dependencies.stopped_helpers.stop(
        session.task.record.session_id,
        "stopped-helper",
        HelperStopReason::TokenLimit,
    );
    delivery
        .deliver_turn_started(
            &mut session.task.record,
            &started("stopped-helper", "turn-b"),
        )
        .await;

    let interrupt = session.scripted.script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": "stopped-helper", "turnId": "turn-b"})
    );
    session.scripted.script.answer(&interrupt, &json!({}));
    tokio::task::yield_now().await;
    assert!(
        session.scripted.script.sent.try_recv().is_err(),
        "the helper never stopped is sent nothing"
    );
}

// The words OpenAI refuses a mistyped key with, quoting `key` where the key goes.
fn mistyped_key_words(key: &str) -> String {
    format!(
        "Incorrect API key provided: {key}. You can find your API key at \
         https://platform.openai.com/account/api-keys."
    )
}

// A key as OpenAI quotes it in that refusal: its prefix and last four characters around a mask.
fn quoted_key_fragment() -> String {
    format!("sk-proj-{}wxyz", "*".repeat(48))
}

// Codex's words reach the failed run's detail, which is stored and published, with the quoted key
// masked and nothing else changed, whether they came on the turn's end or on its last error frame.
// Kills: the mask skipped on the failed turn's error or on the error frame's, or words without a
// key changed.
#[rstest]
#[case::on_the_failed_turn(false, true)]
#[case::on_the_error_frame(true, true)]
#[case::with_no_key(false, false)]
#[tokio::test]
async fn a_failed_turns_detail_masks_the_key_codex_quotes(
    #[case] is_on_error_frame: bool,
    #[case] is_quoting_a_key: bool,
) {
    let (words, expected) = if is_quoting_a_key {
        (
            mistyped_key_words(&quoted_key_fragment()),
            mistyped_key_words("***"),
        )
    } else {
        (
            "The server is busy.".to_owned(),
            "The server is busy.".to_owned(),
        )
    };
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    session.daemon_turn_bindings.open_on(binding_id);
    session.scripted.script.send(&turn_started("turn-1"));
    session.task.handle_next().await;
    let mut completed = turn_completed(TEST_THREAD, "turn-1", "failed");
    if is_on_error_frame {
        let mut error = error_frame("unauthorized", false);
        error["params"]["error"]["message"] = json!(words);
        session.scripted.script.send(&error);
        session.task.handle_next().await;
    } else {
        completed["params"]["turn"]["error"] = json!({"message": words});
    }

    session.scripted.script.send(&completed);
    session.task.handle_next().await;

    let details: Vec<Option<String>> = session
        .engine
        .run_moves()
        .into_iter()
        .filter_map(|change| {
            let RunStateEntry::Failed {
                provider_failure_detail,
                ..
            } = change.entry
            else {
                return None;
            };
            Some(provider_failure_detail.map(|detail| detail.as_str().to_owned()))
        })
        .collect();
    assert_eq!(details, [Some(expected)]);
}
