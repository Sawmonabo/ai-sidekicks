use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::CAN_LINK_A_SOCKET;
use tokio::task::JoinHandle;

use super::CodexServiceRegistry;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service, start_scripted_terminal_service,
};
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_contracts::wire::id::mint_uuid_v7;

const THREAD: &str = "thread-1";

/// A conversation a terminal started, which no session holds.
const TERMINAL_THREAD: &str = "terminal-thread-1";

/// How long the test watches for a read that must not come yet.
const QUIET_WAIT: Duration = Duration::from_millis(300);

// Holds `THREAD` on the scripted service for a session, answering the first list read with one
// running command.
async fn hold_with_a_running_command(scripted: &mut ScriptedCodexService) {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let release = Arc::clone(&scripted.dependencies.release);
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
}

// Lets the held conversation go: it goes idle with no command left, and Codex unsubscribes it.
async fn let_the_hold_go(scripted: &mut ScriptedCodexService) {
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "thread/status/changed",
        "params": {"threadId": THREAD, "status": {"type": "idle"}}}));
    let list = next_request(scripted, "thread/backgroundTerminals/list").await;
    scripted.script.answer(&list, &json!({"data": []}));
    let unsubscribe = next_request(scripted, "thread/unsubscribe").await;
    scripted
        .script
        .answer(&unsubscribe, &json!({"status": "unsubscribed"}));
}

// The next request the connection sent, which must be `method`.
async fn next_request(scripted: &mut ScriptedCodexService, method: &str) -> Value {
    let request = scripted.script.next_sent().await;
    assert_eq!(request["method"], method, "{request}");
    request
}

// Turns the folder's terminal service off, which answers before the service is free: it leaves
// the folder at once, and its retirement's task is answered.
async fn switch_off(registry: &CodexServiceRegistry) -> JoinHandle<()> {
    let retiring = tokio::time::timeout(QUIET_WAIT, registry.stop_terminal_service())
        .await
        .expect("the switch-off answers before the service is free")
        .expect("the home resolves")
        .expect("the folder's terminal service is retired");
    assert!(
        registry.services().is_empty(),
        "the service still holds the folder"
    );
    retiring
}

// Fails when the switch-off waits for the service to be free before it answers, or when its
// retirement reads the conversations inside the service, or stops it, before a conversation a
// session moved off it lets go once its command ends.
#[tokio::test]
async fn the_switch_off_retires_once_a_held_conversation_lets_go() {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);
    hold_with_a_running_command(&mut scripted).await;

    let retiring = switch_off(&registry).await;
    let_the_hold_go(&mut scripted).await;
    let loaded = next_request(&mut scripted, "thread/loaded/list").await;
    let is_retired_before_the_read = retiring.is_finished();
    scripted.script.answer(&loaded, &json!({"data": []}));
    retiring.await.expect("the retirement ends");

    assert!(!is_retired_before_the_read);
    assert!(!scripted.service.is_serving());
}

// Fails when the switch-off's retirement reads the conversations inside the service again, or
// stops it, before a terminal session inside it is unloaded.
#[tokio::test]
async fn the_switch_off_retires_once_a_terminal_session_inside_ends() {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);
    let inside = json!({"data": [TERMINAL_THREAD]});

    let retiring = switch_off(&registry).await;
    let first_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&first_read, &inside);
    let armed_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&armed_read, &inside);
    let read_before_the_unload =
        tokio::time::timeout(QUIET_WAIT, scripted.script.next_sent()).await;
    let is_retired_before_the_unload = retiring.is_finished();
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "thread/closed",
            "params": {"threadId": TERMINAL_THREAD}}));
    let last_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&last_read, &json!({"data": []}));
    retiring.await.expect("the retirement ends");

    assert!(
        read_before_the_unload.is_err(),
        "the retirement read again before the terminal session ended"
    );
    assert!(!is_retired_before_the_unload);
    assert!(!scripted.service.is_serving());
}

// Fails when the switch-off's retirement reads a reconnecting service as free, which stops it
// while a terminal session inside it waits for the connection to come back.
#[tokio::test]
async fn the_switch_off_retires_a_reconnecting_service_once_it_is_back() {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);
    let connection = scripted.publish_reconnecting();

    let retiring = switch_off(&registry).await;
    let read_while_reconnecting =
        tokio::time::timeout(QUIET_WAIT, scripted.script.next_sent()).await;
    let is_retired_while_reconnecting = retiring.is_finished();
    scripted.publish_up(connection);
    let loaded = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&loaded, &json!({"data": []}));
    retiring.await.expect("the retirement ends");

    assert!(
        read_while_reconnecting.is_err(),
        "the retirement read the service while it reconnected"
    );
    assert!(!is_retired_while_reconnecting);
}

// Fails when a planned restart where the home's socket cannot be moved stops the first service
// before a conversation a session moved off it lets go once its command ends. Runs only where the
// system refuses to move a socket link.
#[tokio::test]
async fn a_restart_on_an_unmovable_socket_stops_the_first_once_its_held_conversation_lets_go() {
    if CAN_LINK_A_SOCKET {
        return;
    }
    let mut scripted = start_scripted_codex_service();
    let registry = CodexServiceRegistry::holding(&scripted);
    hold_with_a_running_command(&mut scripted).await;

    let replacing = {
        let registry = Arc::clone(&registry);
        let first = Arc::clone(&scripted.service);
        tokio::spawn(async move { registry.replace(&first).await.map(|_second| ()) })
    };
    let_the_hold_go(&mut scripted).await;
    let loaded = next_request(&mut scripted, "thread/loaded/list").await;
    let is_replaced_before_the_read = replacing.is_finished();
    scripted.script.answer(&loaded, &json!({"data": []}));
    let replaced = replacing.await.expect("the restart ends");

    assert!(!is_replaced_before_the_read);
    // The scripted dependencies run no program, so the second's start fails after the stop.
    assert!(replaced.is_err());
    assert!(
        registry
            .services()
            .iter()
            .any(|kept| Arc::ptr_eq(kept, &scripted.service))
    );
}

// Fails when the switch-off's failed wait leaves the folder with no service, which strands its
// sessions on one nothing reaches, or puts it back over the service the folder took meanwhile.
#[rstest]
#[case::the_slot_left_empty(false)]
#[case::the_slot_filled_meanwhile(true)]
#[tokio::test]
async fn a_failed_switch_off_wait_puts_the_service_back_only_into_an_empty_slot(
    #[case] is_slot_filled: bool,
) {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);

    let retiring = switch_off(&registry).await;
    let loaded = next_request(&mut scripted, "thread/loaded/list").await;
    let filling = if is_slot_filled {
        Some(registry.service_for(None).await.expect("the home resolves"))
    } else {
        None
    };
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "id": loaded["id"],
        "error": {"code": -32603, "message": "the read failed"}}));
    retiring.await.expect("the retirement ends");
    let registered = registry.services();
    registry.shutdown(DaemonStopIntent::Stop).await;

    let expected = filling.unwrap_or_else(|| Arc::clone(&scripted.service));
    assert!(
        registered.len() == 1 && Arc::ptr_eq(&registered[0], &expected),
        "the folder's service is not the one expected"
    );
}

mod former_services;
mod hooks;
mod socket_link;
mod stand_in;
