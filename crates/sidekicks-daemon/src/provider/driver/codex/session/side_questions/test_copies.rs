//! Test support for a side question's copy: the resting session it is asked on, and a scripted
//! Codex that serves the copy's connection.

use std::path::Path;

use futures::StreamExt as _;
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::codex::permission_level::{CodexProfileFolders, compose_codex_profile_name};
use crate::codex::service::supervisor::test_service::{next_socket_request, send_on_socket};
use crate::driver::session_control::{AskSideQuestionParams, ResumeSessionParams};
use crate::run::posture::compose_execution_posture;

/// The resting session's stored conversation.
pub(crate) const STORED_THREAD: &str = "stored-thread";

/// The copy the service forks from it.
pub(crate) const COPY_THREAD: &str = "copy-thread";

/// The copy's one turn.
pub(crate) const COPY_TURN: &str = "copy-turn";

/// The copy's answer.
pub(crate) const ANSWER: &str = "It reads the worktree.";

/// The resume material of `session_id` at rest in `folder` on the person's own sign-in.
pub(crate) fn resting_session(session_id: SessionId, folder: &Path) -> ResumeSessionParams {
    ResumeSessionParams {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        resume_handle: STORED_THREAD.to_owned(),
        model: ProviderToken::new("gpt-5".to_owned()).expect("the model fits"),
        larger_window: None,
        mode: SessionMode::Build,
        execution_posture: Some(compose_execution_posture(
            PermissionLevel::Ask,
            FilesystemPath::new(folder.display().to_string()).expect("the folder is a path"),
        )),
        output_speed: None,
        options: Vec::new(),
        row_values: Record::default(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id: None,
        on_mcp_server_status: None,
    }
}

/// A side question asked on `session_id` at rest in `folder`, its stored conversation
/// `stored-thread`, at Ask on the person's own sign-in.
pub(crate) fn resting_question(session_id: SessionId, folder: &Path) -> AskSideQuestionParams {
    AskSideQuestionParams {
        session_id,
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "What does this read?".to_owned(),
        resume: Some(resting_session(session_id, folder)),
    }
}

/// The read-only profile a copy whose working folder is `folder`'s `work` runs under.
pub(crate) fn read_only_profile(folder: &Path) -> String {
    compose_codex_profile_name(
        PermissionLevel::Readonly,
        &CodexProfileFolders {
            working_directory: folder.join("work"),
            git_common_folder: None,
            deny_paths: Vec::new(),
        },
    )
}

/// The service's side of a copy's connection.
pub(crate) type CopySocket = WebSocketStream<interprocess::local_socket::tokio::Stream>;

/// Serves the copy's connection as Codex through the connection's start; answers the connection.
pub(crate) async fn accept_copy(listener: &Listener) -> CopySocket {
    let stream = listener
        .accept()
        .await
        .expect("the daemon dials the service");
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .expect("the daemon upgrades its connection");
    let initialize = next_socket_request(&mut socket).await;
    assert_eq!(initialize["method"], "initialize");
    send_on_socket(
        &mut socket,
        json!({"id": initialize["id"], "result": {"userAgent": "codex/0.163.0 (test)"}}),
    )
    .await;
    socket
}

/// Serves the copy's connection as Codex up to its turn's start: the connection's start and a fork
// of the stored conversation under `profile`; answers the connection and the fork's params.
pub(crate) async fn open_copy(
    listener: &Listener,
    profile: &str,
) -> (CopySocket, Map<String, Value>) {
    let mut socket = accept_copy(listener).await;
    let fork = next_socket_request(&mut socket).await;
    assert_eq!(fork["method"], "thread/fork");
    send_on_socket(
        &mut socket,
        json!({"id": fork["id"], "result": {
            "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
            "activePermissionProfile": {"id": profile},
        }}),
    )
    .await;
    let turn = next_socket_request(&mut socket).await;
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], COPY_THREAD);
    send_on_socket(
        &mut socket,
        json!({"id": turn["id"], "result": {"turn": {"id": COPY_TURN, "items": [],
            "status": "inProgress"}}}),
    )
    .await;
    let fork = fork["params"]
        .as_object()
        .expect("the fork's params are an object")
        .clone();
    (socket, fork)
}

/// Serves the copy's connection as Codex: its start, a fork of the stored conversation under
// `profile`, one turn and its answer; answers the fork's params once the daemon let the
// connection go.
pub(crate) async fn serve_copy(listener: Listener, profile: String) -> Map<String, Value> {
    let (mut socket, fork) = open_copy(&listener, &profile).await;
    send_on_socket(
        &mut socket,
        json!({"jsonrpc": "2.0", "method": "item/completed", "params": {
            "threadId": COPY_THREAD,
            "turnId": COPY_TURN,
            "item": {"type": "agentMessage", "id": "item-1", "text": ANSWER},
        }}),
    )
    .await;
    send_on_socket(
        &mut socket,
        json!({"jsonrpc": "2.0", "method": "turn/completed", "params": {
            "threadId": COPY_THREAD,
            "turn": {"id": COPY_TURN, "items": [], "status": "completed"},
        }}),
    )
    .await;
    // The copy is let go with its connection once it answered.
    while let Some(Ok(_message)) = socket.next().await {}
    fork
}

/// Serves the copy's connection as Codex through its turn's start and never ends the turn, and
/// answers each later request, the let-go of the conversation among them, so a stop does not wait
/// out its bound; answers the interrupt the daemon sent once it let the connection go.
pub(crate) async fn serve_unended_copy(listener: Listener, profile: String) -> Value {
    let (mut socket, _fork) = open_copy(&listener, &profile).await;
    let interrupt = next_socket_request(&mut socket).await;
    send_on_socket(&mut socket, json!({"id": interrupt["id"], "result": {}})).await;
    while let Some(Ok(message)) = socket.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request.get("id").is_some() {
            send_on_socket(&mut socket, json!({"id": request["id"], "result": {}})).await;
        }
    }
    interrupt
}
