//! A listener's answers as a Codex service gives them, as far as a start, a machine probe, a
//! resume and a turn's start need, and the shell stand-in that answers as Codex's executor.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sidekicks_platforms::pin_running_process;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::{TEST_DISPATCHES_HOOK_MODE, TEST_SESSION_SHELL_KIND};
use crate::driver::codex::service::command_line::{
    TerminalServiceHooks, read_terminal_service_hooks,
};
use crate::driver::codex::session::errors::{
    CODEX_ACTIVE_WRITER_MESSAGE, CODEX_INVALID_REQUEST_CODE,
};

/// A Codex stand-in: as the executor it answers the relay's `initialize` and waits on its input;
/// as the service it waits, the test's listener answering in its place.
#[cfg(test)]
pub(crate) const STAND_IN_CODEX: &str = r#"#!/bin/sh
case " $* " in
  *" exec-server "*)
    IFS= read -r _initialize
    printf '%s\n' '{"id":"sidekicks-relay-1","result":{}}'
    exec cat >/dev/null
    ;;
esac
exec sleep 30
"#;

/// The conversation a machine probe's ephemeral start opens on a test service.
pub(crate) const PROBE_THREAD_ID: &str = "probe-thread";

/// The one tool each server a test service lists for a machine probe has.
pub(crate) const PROBE_TOOL_NAME: &str = "lookup";

// How long a stand-in that lets a writer go takes to unload the conversation once unsubscribed,
// as Codex unloads one a delay after no client holds it.
const UNLOAD_DELAY: Duration = Duration::from_millis(500);

// The turn a test service starts at every `turn/start`.
const STAND_IN_TURN_ID: &str = "stand-in-turn";

/// The answers a test gives a stand-in service in place of its own, each `None` to keep its own.
#[derive(Clone, Debug, Default)]
pub(crate) struct StandInReplies {
    /// The reply to a config read.
    pub(crate) config_read: Option<Value>,
    /// The one turn listed on every conversation the service resumes, which the resume answers as
    /// running while the turn is in progress.
    pub(crate) resumed_turn: Option<Value>,
    /// The folder each resumed conversation's writer is kept in, by the conversation's id: a
    /// resume of one another running stand-in still writes is refused as Codex refuses it.
    pub(crate) conversation_writers: Option<PathBuf>,
    /// Whether an unsubscribe from a conversation this service writes ends its writing, as Codex
    /// unloads an idle conversation no client holds, its `thread/closed` sent.
    pub(crate) is_writer_let_go: bool,
}

/// Answers one connection's requests on `stream` as far as a start needs, telling `on_request`
/// each request as it comes: the version, the hooks the daemon starts a terminal service with, as
/// trusted, and no loaded conversation; a config write is refused, so a start that writes trust
/// fails. A machine probe is answered too: its ephemeral start opens [`PROBE_THREAD_ID`], each
/// server its config switches on or sends reports ready, and each listed server is connected with
/// [`PROBE_TOOL_NAME`]. A config read is answered with `replies`' where one is given, else with an
/// empty config, and where a resumed turn is given, a resume is answered on the conversation it
/// names, under the profile it asks for, unless another running stand-in still writes it where
/// writers are kept, and that conversation's turns are listed as that one turn; where `replies`
/// let a writer go, a conversation it writes is listed loaded, and an unsubscribe from it ends its
/// writing a short delay later, its `thread/closed` sent then. Once the
/// connection is handed an API key, its account read names an API-key sign-in; before, it answers
/// nothing.
pub(crate) async fn answer_as_codex_service(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    replies: StandInReplies,
    mut on_request: impl FnMut(&Value),
) {
    let hooks =
        match read_terminal_service_hooks(TEST_DISPATCHES_HOOK_MODE, TEST_SESSION_SHELL_KIND)
            .expect("the daemon's hooks read")
        {
            TerminalServiceHooks::Daemon(hooks) => vec![
                listed_hook("preToolUse", &hooks.pre_tool_use),
                listed_hook("postToolUse", &hooks.post_tool_use),
            ],
            TerminalServiceHooks::NoHooks | TerminalServiceHooks::ProgramReplaced => Vec::new(),
        };
    // A probe that only connects ends before the upgrade.
    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let mut is_key_handed = false;
    let (unloads, mut unloaded) = mpsc::unbounded_channel::<Value>();
    loop {
        let message = tokio::select! {
            message = socket.next() => message,
            Some(closed) = unloaded.recv() => {
                if socket.send(Message::Text(closed.to_string().into())).await.is_err() {
                    return;
                }
                continue;
            }
        };
        let Some(Ok(message)) = message else {
            return;
        };
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request.get("id").is_none() {
            continue;
        }
        let id = &request["id"];
        on_request(&request);
        if request["method"] == "account/login/start" && request["params"]["type"] == "apiKey" {
            is_key_handed = true;
        }
        let mut notices = Vec::new();
        let reply = match request["method"].as_str() {
            Some("thread/start") if request["params"]["ephemeral"] == json!(true) => {
                notices = started_probe_servers(&request["params"]);
                json!({"id": id,
                    "result": {"thread": {"id": PROBE_THREAD_ID, "sessionId": "probe-session"}}})
            }
            Some("mcpServerStatus/list") => json!({"id": id, "result": {"data": [{
                "name": request["params"]["serverName"],
                "authStatus": "unsupported",
                "runtimeStatus": "connected",
                "tools": {PROBE_TOOL_NAME: {"name": PROBE_TOOL_NAME, "inputSchema": {}}},
                "resources": [],
                "resourceTemplates": [],
            }], "nextCursor": null}}),
            Some("config/read") if replies.config_read.is_some() => {
                json!({"id": id, "result": replies.config_read})
            }
            Some("config/read") => json!({"id": id, "result": {"config": {}, "origins": {}}}),
            Some("thread/resume") if replies.resumed_turn.is_some() => {
                match refuse_while_written(&request["params"], &replies) {
                    Some(refusal) => json!({"id": id, "error": refusal}),
                    None => {
                        json!({"id": id, "result": resumed_thread(&request["params"], &replies)})
                    }
                }
            }
            Some("thread/unsubscribe") if replies.is_writer_let_go => {
                let_go_written(&request["params"], &replies, &unloads);
                json!({"id": id, "result": {"status": "unsubscribed"}})
            }
            Some("thread/turns/list") if replies.resumed_turn.is_some() => json!({"id": id,
                "result": {"data": [replies.resumed_turn], "nextCursor": null}}),
            Some("turn/start") => {
                let turn = json!({"id": STAND_IN_TURN_ID, "items": [], "status": "inProgress"});
                notices.push(json!({"jsonrpc": "2.0", "method": "turn/started",
                    "params": {"threadId": request["params"]["threadId"], "turn": turn}}));
                json!({"id": id, "result": {"turn": turn}})
            }
            Some("config/value/write") => json!({"id": id,
                "error": {"code": -32603, "message": "the test service writes no config"}}),
            Some("initialize") => json!({"id": id,
                "result": {"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"}}),
            Some("hooks/list") => json!({"id": id, "result": {"data": [{"hooks": hooks}]}}),
            Some("thread/loaded/list") if replies.is_writer_let_go => {
                json!({"id": id, "result": {"data": own_written(&replies)}})
            }
            Some("thread/loaded/list") => json!({"id": id, "result": {"data": []}}),
            Some("account/read") if is_key_handed => {
                json!({"id": id, "result": {"account": {"type": "apiKey"}}})
            }
            _ => json!({"id": id, "result": {}}),
        };
        for message in std::iter::once(reply).chain(notices) {
            if socket
                .send(Message::Text(message.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

// Codex's refusal to resume the conversation `params` names while another running stand-in
// still writes it, by `replies`' writers; `None` once this stand-in writes it, as it records.
fn refuse_while_written(params: &Value, replies: &StandInReplies) -> Option<Value> {
    let writers = replies.conversation_writers.as_ref()?;
    let writer = writers.join(
        params["threadId"]
            .as_str()
            .expect("a resume names its conversation"),
    );
    let own = std::process::id();
    let other = std::fs::read_to_string(&writer)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|process_id| *process_id != own);
    if other.is_some_and(|process_id| {
        pin_running_process(process_id)
            .expect("the process table reads")
            .is_some()
    }) {
        return Some(json!({
            "code": CODEX_INVALID_REQUEST_CODE,
            "message": format!("the conversation has an {CODEX_ACTIVE_WRITER_MESSAGE}"),
        }));
    }
    std::fs::create_dir_all(writers).expect("the writers' folder is made");
    std::fs::write(&writer, own.to_string()).expect("the writer is recorded");
    None
}

// Ends this stand-in's writing of the conversation `params` names, where `replies`' writers name
// it as its writer, [`UNLOAD_DELAY`] from now, then hands `unloads` the `thread/closed` its unload
// sends.
fn let_go_written(
    params: &Value,
    replies: &StandInReplies,
    unloads: &mpsc::UnboundedSender<Value>,
) {
    let thread_id = params["threadId"]
        .as_str()
        .expect("an unsubscribe names its conversation")
        .to_owned();
    let Some(writers) = &replies.conversation_writers else {
        return;
    };
    let writer = writers.join(&thread_id);
    if !is_own_writer(&writer) {
        return;
    }
    let unloads = unloads.clone();
    tokio::spawn(async move {
        tokio::time::sleep(UNLOAD_DELAY).await;
        std::fs::remove_file(&writer).expect("the writer is removed");
        // A connection that closed meanwhile hears no close.
        let _unheard = unloads.send(json!({"jsonrpc": "2.0", "method": "thread/closed",
            "params": {"threadId": thread_id}}));
    });
}

// The conversations `replies`' writers name this stand-in as the writer of, which it holds loaded.
fn own_written(replies: &StandInReplies) -> Vec<String> {
    let Some(writers) = &replies.conversation_writers else {
        return Vec::new();
    };
    // No writer was recorded yet.
    if !writers.exists() {
        return Vec::new();
    }
    std::fs::read_dir(writers)
        .expect("the writers' folder lists")
        .map(|entry| entry.expect("the writers' folder lists").path())
        .filter(|writer| is_own_writer(writer))
        .filter_map(|writer| Some(writer.file_name()?.to_str()?.to_owned()))
        .collect()
}

// Whether the writer file `writer` names this stand-in's process.
fn is_own_writer(writer: &Path) -> bool {
    let own = std::process::id().to_string();
    std::fs::read_to_string(writer).is_ok_and(|text| text.trim() == own)
}

// A resume's reply on the conversation `params` names, under the profile they ask for, running
// while `replies`' resumed turn is in progress and idle otherwise.
fn resumed_thread(params: &Value, replies: &StandInReplies) -> Value {
    let status = match replies.resumed_turn.as_ref().map(|turn| &turn["status"]) {
        Some(status) if status == "inProgress" => "active",
        _ => "idle",
    };
    json!({
        "thread": {
            "id": params["threadId"],
            "sessionId": "codex-session",
            "status": {"type": status},
        },
        "activePermissionProfile": {"id": params["permissions"]},
    })
}

// The ready notice of each server a probe's start switches on or sends, by its config's server
// table.
fn started_probe_servers(params: &Value) -> Vec<Value> {
    params["config"]["mcp_servers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entry)| entry["enabled"] == json!(true))
        .map(|(name, _)| {
            json!({"jsonrpc": "2.0", "method": "mcpServer/startupStatus/updated", "params": {
                "threadId": PROBE_THREAD_ID, "name": name, "status": "ready", "error": null,
            }})
        })
        .collect()
}

fn listed_hook(event_name: &str, command: &str) -> Value {
    json!({"source": "sessionFlags", "eventName": event_name, "command": command,
        "key": event_name, "currentHash": "hash", "trustStatus": "trusted"})
}
