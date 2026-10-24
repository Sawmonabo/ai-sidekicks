use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
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
use sidekicks_platforms::{ExistingSocket, bind_socket_listener};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use super::CodexSideQuestions;
use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::driver::codex::permission_level::{
    CodexProfileFolders, compose_codex_profile_name,
};
use crate::provider::driver::codex::session::test_session::TestCodexSession;
use crate::provider::driver::session_control::{AskSideQuestionParams, ResumeSessionParams};
use crate::provider::port::registration::PortRegistration;

/// The resting session's stored conversation.
const STORED_THREAD: &str = "stored-thread";

/// The copy the service forks from it.
const COPY_THREAD: &str = "copy-thread";

/// The copy's answer.
const ANSWER: &str = "It reads the worktree.";

/// How long the test waits for the copy to be served and let go.
const SERVE_WAIT: Duration = Duration::from_secs(10);

// A listener at `socket`, or `None` where the system binds no local socket for a test.
fn bind_test_listener(socket: &Path) -> Option<Listener> {
    match bind_socket_listener(socket, ExistingSocket::Refuse) {
        Ok(listener) => Some(listener),
        Err(error) if error.kind() == io::ErrorKind::Unsupported => None,
        Err(error) => panic!("the test's socket does not listen: {error}"),
    }
}

// The resume material of `session_id` at rest on the person's own sign-in.
fn resting_session(session_id: SessionId) -> ResumeSessionParams {
    ResumeSessionParams {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        resume_handle: STORED_THREAD.to_owned(),
        model: ProviderToken::new("gpt-5".to_owned()).expect("the model fits"),
        larger_window: None,
        mode: SessionMode::Build,
        execution_posture: Some(compose_execution_posture(
            PermissionLevel::Ask,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
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

// The next request the daemon sent on `socket`, skipping its notifications.
async fn next_request<Stream>(socket: &mut WebSocketStream<Stream>) -> Value
where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .expect("the daemon keeps the connection")
            .expect("the daemon's message reads");
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request.get("id").is_some() {
            return request;
        }
    }
}

async fn send<Stream>(socket: &mut WebSocketStream<Stream>, message: Value)
where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("the daemon reads");
}

// Serves the copy's connection as Codex: its start, a fork of the stored conversation under
// `profile`, one turn and its answer; answers the fork's params once the daemon let the
// connection go.
async fn serve_copy(listener: Listener, profile: String) -> Map<String, Value> {
    let stream = listener
        .accept()
        .await
        .expect("the daemon dials the service");
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .expect("the daemon upgrades its connection");
    let initialize = next_request(&mut socket).await;
    assert_eq!(initialize["method"], "initialize");
    send(
        &mut socket,
        json!({"id": initialize["id"], "result": {"userAgent": "codex/0.163.0 (test)"}}),
    )
    .await;
    let fork = next_request(&mut socket).await;
    assert_eq!(fork["method"], "thread/fork");
    send(
        &mut socket,
        json!({"id": fork["id"], "result": {
            "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
            "activePermissionProfile": {"id": profile},
        }}),
    )
    .await;
    let turn = next_request(&mut socket).await;
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], COPY_THREAD);
    send(
        &mut socket,
        json!({"id": turn["id"], "result": {"turn": {"id": "copy-turn", "items": [],
            "status": "inProgress"}}}),
    )
    .await;
    send(
        &mut socket,
        json!({"jsonrpc": "2.0", "method": "item/completed", "params": {
            "threadId": COPY_THREAD,
            "turnId": "copy-turn",
            "item": {"type": "agentMessage", "id": "item-1", "text": ANSWER},
        }}),
    )
    .await;
    send(
        &mut socket,
        json!({"jsonrpc": "2.0", "method": "turn/completed", "params": {
            "threadId": COPY_THREAD,
            "turn": {"id": "copy-turn", "items": [], "status": "completed"},
        }}),
    )
    .await;
    // The copy is let go with its connection once it answered.
    while let Some(Ok(_message)) = socket.next().await {}
    fork["params"]
        .as_object()
        .expect("the fork's params are an object")
        .clone()
}

// Killed by refusing a session with no live record, as before it was built, and by forking
// anything but the stored conversation the resume names, under the read-only profile, asking
// nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_side_question_on_a_resting_session_forks_its_stored_conversation_and_answers() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), tasks.clone());
    let session_id = session.task.record.session_id;
    let resume = resting_session(session_id);
    let params = AskSideQuestionParams {
        session_id,
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "What does this read?".to_owned(),
        resume: Some(resume.clone()),
    };
    let profile = compose_codex_profile_name(
        PermissionLevel::Readonly,
        &CodexProfileFolders {
            working_directory: folder.path().join("work"),
            git_common_folder: None,
            deny_paths: Vec::new(),
        },
    );
    let served = tokio::spawn(serve_copy(listener, profile.clone()));

    side_questions
        .ask_at_rest(
            &establishment,
            &resume,
            &params,
            Arc::new(PortRegistration::new("usage")),
        )
        .await
        .expect("the copy takes the question");
    let fork = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go once it answered")
        .expect("the service served the copy");
    tasks.close();
    tasks.wait().await;

    assert_eq!(fork["threadId"], STORED_THREAD);
    assert_eq!(fork["ephemeral"], true);
    assert_eq!(fork["excludeTurns"], true);
    assert_eq!(fork["permissions"], profile.as_str());
    assert_eq!(fork["approvalPolicy"], "never");
    let answers: Vec<String> = session
        .database
        .reader()
        .prepare(
            "SELECT payload FROM session_events WHERE session_id = ?1 \
             AND type = 'session.sideQuestion.answered'",
        )
        .expect("the test reads the session's events")
        .query_map([session_id.text().as_str()], |row| row.get::<_, String>(0))
        .expect("the events read")
        .map(|payload| {
            let payload: Value =
                serde_json::from_str(&payload.expect("a payload reads")).expect("it is JSON");
            payload["answer"]
                .as_str()
                .expect("an answer is text")
                .to_owned()
        })
        .collect();
    assert_eq!(answers, [ANSWER]);
    assert!(
        !session
            .scripted
            .service
            .threads_of(&session_id)
            .iter()
            .any(|thread_id| thread_id == COPY_THREAD),
        "the copy was never registered on the session's service"
    );
}
