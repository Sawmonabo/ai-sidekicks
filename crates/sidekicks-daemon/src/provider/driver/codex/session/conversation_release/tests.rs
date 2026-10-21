use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::uuid_v7::mint_uuid_v7;

const THREAD: &str = "thread-1";

// Holds `THREAD` for its session, answering the first list read with one running command.
async fn hold_with_a_running_command(scripted: &mut ScriptedCodexService) -> SessionId {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let release = Arc::clone(&scripted.release);
    let service = Arc::clone(&scripted.service);
    let held = tokio::spawn(async move {
        release
            .let_go(&service, THREAD.to_owned(), session_id)
            .await;
    });
    let list = next_request(scripted, "thread/backgroundTerminals/list").await;
    scripted
        .script
        .answer(&list, &json!({"data": [{"processId": "41"}]}));
    held.await.expect("the hold ends");
    session_id
}

// The next request the connection sent, which must be `method` on `THREAD`.
async fn next_request(scripted: &mut ScriptedCodexService, method: &str) -> Value {
    let request = scripted.script.next_sent().await;
    assert_eq!(request["method"], method, "{request}");
    assert_eq!(request["params"]["threadId"], THREAD, "{request}");
    request
}

fn frame(method: &str, params: &Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

// Fails when a conversation held for a running command is let go while the command runs, or a
// frame that cannot change what it runs reads the list again, or a command's end or the
// conversation going idle does not.
#[tokio::test]
async fn a_held_conversation_lets_go_only_once_no_command_runs() {
    let mut scripted = start_scripted_codex_service();
    hold_with_a_running_command(&mut scripted).await;

    scripted.script.send(&frame(
        "item/agentMessage/delta",
        &json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "item-1", "delta": "more"}),
    ));
    scripted.script.send(&frame(
        "item/completed",
        &json!({"threadId": THREAD, "turnId": "turn-1",
            "item": {"type": "commandExecution", "id": "item-2"}}),
    ));
    let after_command = next_request(&mut scripted, "thread/backgroundTerminals/list").await;
    scripted
        .script
        .answer(&after_command, &json!({"data": [{"processId": "41"}]}));
    scripted.script.send(&frame(
        "thread/status/changed",
        &json!({"threadId": THREAD, "status": {"type": "idle"}}),
    ));
    let after_idle = next_request(&mut scripted, "thread/backgroundTerminals/list").await;
    scripted.script.answer(&after_idle, &json!({"data": []}));
    let unsubscribe = next_request(&mut scripted, "thread/unsubscribe").await;
    scripted
        .script
        .answer(&unsubscribe, &json!({"status": "unsubscribed"}));
    scripted
        .release
        .when_none_held_on(scripted.service.id())
        .await;

    assert!(
        scripted.script.sent.try_recv().is_err(),
        "a frame that changes nothing read the list again"
    );
}

// Fails when a session's close leaves a command of a conversation it moved off running, skips a
// page of the list, does not have Codex drop the ended commands' records, or lets go of the
// conversation while its list still shows a command.
#[tokio::test]
async fn ending_a_session_terminates_every_listed_command_then_cleans_then_unsubscribes() {
    let mut scripted = start_scripted_codex_service();
    let session_id = hold_with_a_running_command(&mut scripted).await;

    let release = Arc::clone(&scripted.release);
    let forgotten = tokio::spawn(async move { release.forget_session(&session_id).await });
    let first_page = next_request(&mut scripted, "thread/backgroundTerminals/list").await;
    scripted.script.answer(
        &first_page,
        &json!({"data": [{"processId": "41"}], "nextCursor": "page-2"}),
    );
    let second_page = next_request(&mut scripted, "thread/backgroundTerminals/list").await;
    scripted
        .script
        .answer(&second_page, &json!({"data": [{"processId": "42"}]}));
    let mut terminated = Vec::new();
    for _command in 0..2 {
        let terminate = next_request(&mut scripted, "thread/backgroundTerminals/terminate").await;
        terminated.push(terminate["params"]["processId"].clone());
        scripted.script.answer(&terminate, &json!({}));
    }
    let clean = next_request(&mut scripted, "thread/backgroundTerminals/clean").await;
    scripted.script.answer(&clean, &json!({}));
    let after_clean = next_request(&mut scripted, "thread/backgroundTerminals/list").await;
    scripted
        .script
        .answer(&after_clean, &json!({"data": [{"processId": "42"}]}));
    forgotten.await.expect("the close ends");

    assert_eq!(second_page["params"]["cursor"], "page-2");
    assert_eq!(terminated, [json!("41"), json!("42")]);
    assert!(
        scripted.script.sent.try_recv().is_err(),
        "the conversation was let go while a command ran"
    );
}
