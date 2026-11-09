use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::session::controls::methods::{
    TerminalProviderSession, TerminalProviderSessionState,
};
use sidekicks_contracts::wire::text::ComposedText;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_terminal_service;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::test_registry::new_session_id;

/// A conversation a session of the app holds.
const HELD: &str = "held-thread";

/// A person's conversation with a turn running and only a preview.
const TYPED: &str = "typed-thread";

/// A person's idle conversation with a name of its own.
const NAMED: &str = "named-thread";

/// A helper Codex started for a conversation.
const HELPER: &str = "helper-thread";

/// A one-off run's conversation, which Codex does not keep.
const EPHEMERAL: &str = "ephemeral-thread";

/// A kept conversation another app-server client started, which no session of the app holds.
const APP_SERVER: &str = "app-server-thread";

/// A conversation whose read fails.
const SILENT: &str = "silent-thread";

/// How long a listing is given to ask the service what it holds loaded.
const ASK_WAIT: Duration = Duration::from_secs(5);

// Fails when the list names a conversation a session holds, a helper's, a one-off run's or one
// another app-server client started, when one failed read fails the whole list, when a name falls back past the preview to the id, or
// when a running turn does not read as working.
#[tokio::test]
async fn the_list_names_the_typed_conversations_no_session_holds() {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);
    scripted
        .service
        .register_thread(HELD.to_owned(), new_session_id());

    let listing = tokio::spawn(async move { registry.list_terminal_sessions().await });
    let loaded = scripted.next_request("thread/loaded/list").await;
    scripted.script.answer(
        &loaded,
        &json!({"data": [HELD, TYPED, NAMED, HELPER, EPHEMERAL, APP_SERVER, SILENT],
            "nextCursor": null}),
    );
    let mut read_ids = Vec::new();
    for _read in 0..6 {
        let read = scripted.next_request("thread/read").await;
        let thread_id = read["params"]["threadId"]
            .as_str()
            .expect("a read names its thread")
            .to_owned();
        match thread_id.as_str() {
            TYPED => answer_thread(
                &scripted.script,
                &read,
                json!({"name": null, "preview": "fix the flaky test", "source": "cli",
                    "ephemeral": false, "status": {"type": "active", "activeFlags": []}}),
            ),
            NAMED => answer_thread(
                &scripted.script,
                &read,
                json!({"name": "Release notes", "preview": "", "source": "cli",
                    "ephemeral": false, "status": {"type": "idle"}}),
            ),
            HELPER => answer_thread(
                &scripted.script,
                &read,
                json!({"name": null, "preview": "", "ephemeral": false,
                    "source": {"subAgent": {"thread_spawn": {"parent_thread_id": TYPED}}},
                    "status": {"type": "idle"}}),
            ),
            EPHEMERAL => answer_thread(
                &scripted.script,
                &read,
                json!({"name": null, "preview": "", "source": "cli", "ephemeral": true,
                    "status": {"type": "idle"}}),
            ),
            APP_SERVER => answer_thread(
                &scripted.script,
                &read,
                json!({"name": "Dashboard work", "preview": "", "source": "appServer",
                    "ephemeral": false, "status": {"type": "idle"}}),
            ),
            _ => scripted
                .script
                .send(&json!({"jsonrpc": "2.0", "id": read["id"],
                "error": {"code": -32603, "message": "the read failed"}})),
        }
        read_ids.push(thread_id);
    }
    let listed = listing.await.expect("the listing ends");

    assert_eq!(
        listed.expect("the list reads"),
        vec![
            terminal_session(
                TYPED,
                "fix the flaky test",
                TerminalProviderSessionState::Working
            ),
            terminal_session(NAMED, "Release notes", TerminalProviderSessionState::Idle),
            terminal_session(SILENT, SILENT, TerminalProviderSessionState::Unreachable),
        ]
    );
    assert!(!read_ids.iter().any(|id| id == HELD), "{read_ids:?}");
}

// Fails when a conversation stays listed after Codex closes it, as one kept between listings
// would: each listing asks the service again what it holds loaded.
#[tokio::test]
async fn a_terminal_session_leaves_the_list_at_its_close() {
    let mut scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding(&scripted);

    let first_listing = tokio::spawn({
        let registry = Arc::clone(&registry);
        async move { registry.list_terminal_sessions().await }
    });
    let loaded = scripted.next_request("thread/loaded/list").await;
    scripted
        .script
        .answer(&loaded, &json!({"data": [NAMED], "nextCursor": null}));
    let read = scripted.next_request("thread/read").await;
    answer_thread(
        &scripted.script,
        &read,
        json!({"name": "Release notes", "preview": "", "source": "cli", "ephemeral": false,
            "status": {"type": "idle"}}),
    );
    let first_listed = first_listing.await.expect("the first listing ends");
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "thread/closed",
            "params": {"threadId": NAMED}}));
    let second_listing = tokio::spawn(async move { registry.list_terminal_sessions().await });
    let loaded = tokio::time::timeout(ASK_WAIT, scripted.next_request("thread/loaded/list"))
        .await
        .expect("the second listing asks what the service holds loaded");
    scripted
        .script
        .answer(&loaded, &json!({"data": [], "nextCursor": null}));
    let second_listed = second_listing.await.expect("the second listing ends");

    assert_eq!(
        first_listed.expect("the first list reads"),
        vec![terminal_session(
            NAMED,
            "Release notes",
            TerminalProviderSessionState::Idle
        )]
    );
    assert_eq!(second_listed.expect("the second list reads"), Vec::new());
}

// Answers the `thread/read` request `read` with a thread of `members`, its own id and session id
// beside them.
fn answer_thread(script: &ScriptedService, read: &Value, mut members: Value) {
    members["id"] = read["params"]["threadId"].clone();
    members["sessionId"] = json!("codex-session-1");
    script.answer(read, &json!({"thread": members}));
}

fn terminal_session(
    thread_id: &str,
    name: &str,
    state: TerminalProviderSessionState,
) -> TerminalProviderSession {
    TerminalProviderSession {
        provider: DESCRIPTOR.provider_id(),
        name: ComposedText::new(name.to_owned()).expect("the name is not empty"),
        thread_id: ComposedText::new(thread_id.to_owned()).expect("the id is not empty"),
        state,
    }
}
