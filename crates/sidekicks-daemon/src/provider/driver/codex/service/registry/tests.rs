use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::replace_socket_link;

use super::{CodexHomeResolver, CodexServiceRegistry};
use crate::provider::driver::codex::service::home::CodexServiceHome;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::provider::driver::contract::DriverError;
use crate::uuid_v7::mint_uuid_v7;

const THREAD: &str = "thread-1";

/// A conversation a terminal started, which no session holds.
const TERMINAL_THREAD: &str = "terminal-thread-1";

/// How long the test watches for a read that must not come yet.
const QUIET_WAIT: Duration = Duration::from_millis(300);

// Every account resolves to the one home a test names.
struct OneHome(CodexServiceHome);

impl CodexHomeResolver for OneHome {
    fn codex_home_for<'call>(
        &'call self,
        _provider_account_id: Option<&'call ProviderAccountId>,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        let home = self.0.clone();
        Box::pin(async move { Ok(home) })
    }
}

// A registry holding the scripted service as its home's.
fn registry_holding(scripted: &ScriptedCodexService) -> Arc<CodexServiceRegistry> {
    let home = scripted.service.home().clone();
    let registry = Arc::new(CodexServiceRegistry::new(
        Arc::new(OneHome(home.clone())),
        Arc::clone(&scripted.dependencies),
    ));
    registry
        .lock()
        .by_home
        .insert(home.codex_home, Arc::clone(&scripted.service));
    registry
}

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

// Fails when the switch-off stop reads the conversations inside the service, or stops it, before
// a conversation a session moved off it lets go once its command ends.
#[tokio::test]
async fn the_switch_off_stop_waits_for_a_held_conversation_to_let_go() {
    let mut scripted = start_scripted_codex_service();
    let registry = registry_holding(&scripted);
    hold_with_a_running_command(&mut scripted).await;

    let stopping = {
        let registry = Arc::clone(&registry);
        tokio::spawn(async move { registry.stop_terminal_service().await })
    };
    let_the_hold_go(&mut scripted).await;
    let loaded = next_request(&mut scripted, "thread/loaded/list").await;
    let is_stopped_before_the_read = stopping.is_finished();
    scripted.script.answer(&loaded, &json!({"data": []}));
    let stopped = stopping.await.expect("the stop ends");

    assert!(!is_stopped_before_the_read);
    assert!(stopped.is_ok());
    assert!(registry.services().is_empty());
}

// Fails when the switch-off stop reads the conversations inside the service again, or stops it,
// before a terminal session inside it is unloaded.
#[tokio::test]
async fn the_switch_off_stop_waits_for_a_terminal_session_inside_to_end() {
    let mut scripted = start_scripted_codex_service();
    let registry = registry_holding(&scripted);
    let inside = json!({"data": [TERMINAL_THREAD]});

    let stopping = {
        let registry = Arc::clone(&registry);
        tokio::spawn(async move { registry.stop_terminal_service().await })
    };
    let first_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&first_read, &inside);
    let armed_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&armed_read, &inside);
    let read_before_the_unload =
        tokio::time::timeout(QUIET_WAIT, scripted.script.next_sent()).await;
    let is_stopped_before_the_unload = stopping.is_finished();
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "thread/closed",
            "params": {"threadId": TERMINAL_THREAD}}));
    let last_read = next_request(&mut scripted, "thread/loaded/list").await;
    scripted.script.answer(&last_read, &json!({"data": []}));
    let stopped = stopping.await.expect("the stop ends");

    assert!(
        read_before_the_unload.is_err(),
        "the stop read again before the terminal session ended"
    );
    assert!(!is_stopped_before_the_unload);
    assert!(stopped.is_ok());
    assert!(registry.services().is_empty());
}

// Whether this system moves a socket link, which only a system whose socket path is a link does.
fn can_move_socket_links() -> bool {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let moved = replace_socket_link(&scratch.path().join("link"), &scratch.path().join("socket"));
    !matches!(moved, Err(error) if error.kind() == io::ErrorKind::Unsupported)
}

// Fails when a planned restart where the home's socket cannot be moved stops the first service
// before a conversation a session moved off it lets go once its command ends. Runs only where the
// system refuses to move a socket link.
#[tokio::test]
async fn a_restart_on_an_unmovable_socket_stops_the_first_once_its_held_conversation_lets_go() {
    if can_move_socket_links() {
        return;
    }
    let mut scripted = start_scripted_codex_service();
    let registry = registry_holding(&scripted);
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

mod socket_link;
