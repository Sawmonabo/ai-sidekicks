use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
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
use tokio::sync::oneshot;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use super::{CodexSideQuestions, lock_copy_stops};
use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::driver::codex::permission_level::{
    CodexProfileFolders, compose_codex_profile_name,
};
use crate::provider::driver::codex::session::test_session::{TestCodexSession, turn_reply};
use crate::provider::driver::codex::transport::connection::scripted_service::ScriptedService;
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

// A side question asked on `session_id` at rest.
fn resting_question(session_id: SessionId) -> AskSideQuestionParams {
    AskSideQuestionParams {
        session_id,
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "What does this read?".to_owned(),
        resume: Some(resting_session(session_id)),
    }
}

// The read-only profile a copy whose working folder sits in `folder` runs under.
fn read_only_profile(folder: &Path) -> String {
    compose_codex_profile_name(
        PermissionLevel::Readonly,
        &CodexProfileFolders {
            working_directory: folder.join("work"),
            git_common_folder: None,
            deny_paths: Vec::new(),
        },
    )
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

/// The service's side of a copy's connection.
type CopySocket = WebSocketStream<interprocess::local_socket::tokio::Stream>;

// Serves the copy's connection as Codex through the connection's start; answers the connection.
async fn accept_copy(listener: &Listener) -> CopySocket {
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
    socket
}

// Serves the copy's connection as Codex up to its turn's start: the connection's start and a fork
// of the stored conversation under `profile`; answers the connection and the fork's params.
async fn open_copy(listener: &Listener, profile: &str) -> (CopySocket, Map<String, Value>) {
    let mut socket = accept_copy(listener).await;
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
    let fork = fork["params"]
        .as_object()
        .expect("the fork's params are an object")
        .clone();
    (socket, fork)
}

// Serves the copy's connection as Codex: its start, a fork of the stored conversation under
// `profile`, one turn and its answer; answers the fork's params once the daemon let the
// connection go.
async fn serve_copy(listener: Listener, profile: String) -> Map<String, Value> {
    let (mut socket, fork) = open_copy(&listener, &profile).await;
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
    fork
}

// Serves the copy's connection as Codex through its turn's start and never ends the turn; answers
// the interrupt the daemon sent once it let the connection go.
async fn serve_unended_copy(listener: Listener, profile: String) -> Value {
    let (mut socket, _fork) = open_copy(&listener, &profile).await;
    let interrupt = next_request(&mut socket).await;
    send(&mut socket, json!({"id": interrupt["id"], "result": {}})).await;
    while let Some(Ok(_message)) = socket.next().await {}
    interrupt
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
    let params = resting_question(session_id);
    let profile = read_only_profile(folder.path());
    let served = tokio::spawn(serve_copy(listener, profile.clone()));

    side_questions
        .ask_at_rest(
            &establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
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

/// What lets a resting copy go before its turn ends.
enum CopyEnd {
    /// Its session closes.
    SessionClosed,
    /// The driver shuts down.
    DriverShutDown,
}

// Killed by a session's close, or the driver's shutdown, that leaves its resting copy running: no
// interrupt is sent, the copy's connection stays open and the driver's tasks never end.
#[rstest]
#[case::its_session_closes(CopyEnd::SessionClosed)]
#[case::the_driver_shuts_down(CopyEnd::DriverShutDown)]
#[tokio::test(flavor = "multi_thread")]
async fn a_resting_copy_let_go_before_its_turn_ends_has_its_turn_stopped(#[case] end: CopyEnd) {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id);
    let served = tokio::spawn(serve_unended_copy(
        listener,
        read_only_profile(folder.path()),
    ));

    side_questions
        .ask_at_rest(
            &establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
            &params,
            Arc::new(PortRegistration::new("usage")),
        )
        .await
        .expect("the copy takes the question");
    match end {
        CopyEnd::SessionClosed => side_questions.forget_session(session_id).await,
        CopyEnd::DriverShutDown => side_questions.stop_every_copy(),
    }
    let interrupt = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon stops the copy's turn and lets its connection go")
        .expect("the service served the copy");
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("the copy's task ends");

    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": "copy-turn"})
    );
}

/// The reply the service holds while the copy's session closes.
enum HeldReply {
    /// The fork's: the copy has no turn yet.
    Fork,
    /// The turn's start: Codex starts the turn whatever the close.
    TurnStart,
}

// Serves the copy's connection as Codex up to the reply `held` names, telling `reached` once its
// request came; a held fork is never answered, a held start is answered once `release` fires.
// Answers each request the daemon sent after the held one, as its method and params, once it let
// the connection go; an interrupt among them is answered.
async fn serve_held_reply(
    listener: Listener,
    profile: String,
    held: HeldReply,
    reached: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
) -> Vec<Value> {
    let mut socket = accept_copy(&listener).await;
    let fork = next_request(&mut socket).await;
    assert_eq!(fork["method"], "thread/fork");
    if let HeldReply::TurnStart = held {
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
        reached
            .send(())
            .expect("the test waits for the turn's start");
        release.await.expect("the test releases the turn's start");
        send(
            &mut socket,
            json!({"id": turn["id"], "result": {"turn": {"id": "copy-turn", "items": [],
                "status": "inProgress"}}}),
        )
        .await;
    } else {
        reached.send(()).expect("the test waits for the fork");
    }
    let mut later = Vec::new();
    while let Some(Ok(message)) = socket.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request["method"] == "turn/interrupt" {
            send(&mut socket, json!({"id": request["id"], "result": {}})).await;
        }
        later.push(json!({"method": request["method"], "params": request["params"]}));
    }
    later
}

// Killed by entering the resting copy only once its fork answered: the close would miss it, and
// the copy would start its turn on a connection kept open; and by a close that drops the copy's
// turn start in flight, which leaves the turn running with no interrupt.
#[rstest]
#[case::during_its_fork(HeldReply::Fork, json!([]))]
#[case::during_its_turn_start(
    HeldReply::TurnStart,
    json!([{
        "method": "turn/interrupt",
        "params": {"threadId": COPY_THREAD, "turnId": "copy-turn"},
    }]),
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_resting_copy_whose_session_closes_while_it_opens_leaves_no_turn_running(
    #[case] held: HeldReply,
    #[case] sent_after: Value,
) {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id);
    let (reached, held_came) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let is_start_held = matches!(held, HeldReply::TurnStart);
    let served = tokio::spawn(serve_held_reply(
        listener,
        read_only_profile(folder.path()),
        held,
        reached,
        released,
    ));

    let (asked, ()) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(
            side_questions.ask_at_rest(
                &establishment,
                params
                    .resume
                    .as_ref()
                    .expect("the question is asked at rest"),
                &params,
                Arc::new(PortRegistration::new("usage")),
            ),
            async {
                held_came.await.expect("the service took the held request");
                side_questions.forget_session(session_id).await;
                if is_start_held {
                    release.send(()).expect("the service waits for the release");
                }
            },
        )
    })
    .await
    .expect("the ask ends once its copy is let go");
    asked.expect("a copy let go before its turn asks nothing more");
    let later = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("no copy's task is left");

    assert_eq!(Value::from(later), sent_after);
    assert!(
        lock_copy_stops(&side_questions.copy_stops)
            .copies
            .is_empty()
    );
}

// Killed by entering the live copy only once its fork answered: the close would miss it, and the
// copy would start its turn on the session's service.
#[tokio::test]
async fn a_live_copy_whose_session_closes_during_its_fork_starts_no_turn() {
    let mut session = TestCodexSession::start().await;
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), tasks.clone());
    let session_id = session.task.record.session_id;
    let params = AskSideQuestionParams {
        resume: None,
        ..resting_question(session_id)
    };
    let profile = compose_codex_profile_name(
        PermissionLevel::Readonly,
        &session.task.record.thread_settings.profile_folders,
    );
    let script = &mut session.scripted.script;

    let (asked, ()) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(side_questions.ask(&session.task.record, &params), async {
            let fork = script.next_sent().await;
            assert_eq!(fork["method"], "thread/fork");
            side_questions.forget_session(session_id).await;
            script.answer(
                &fork,
                &json!({
                    "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
                    "activePermissionProfile": {"id": profile},
                }),
            );
            let unsubscribe = script.next_sent().await;
            assert_eq!(unsubscribe["method"], "thread/unsubscribe");
            assert_eq!(unsubscribe["params"]["threadId"], COPY_THREAD);
            script.answer(&unsubscribe, &json!({}));
        })
    })
    .await
    .expect("the ask ends once its copy is let go");
    asked.expect("a copy let go before its turn asks nothing more");

    assert!(
        side_questions.lock().is_empty(),
        "the copy was never entered"
    );
    assert!(
        lock_copy_stops(&side_questions.copy_stops)
            .copies
            .is_empty()
    );
    assert!(
        script.sent.try_recv().is_err(),
        "the daemon sent nothing more"
    );
}

/// Where the live copy's turn is when its copy is let go.
enum LiveTurn {
    /// Its start answered.
    Running,
    /// Its start sent and not yet answered.
    Starting,
}

// Lets go of the session's copies as `end` names.
async fn end_copies(side_questions: &CodexSideQuestions, end: &CopyEnd, session_id: SessionId) {
    match end {
        CopyEnd::SessionClosed => side_questions.forget_session(session_id).await,
        CopyEnd::DriverShutDown => side_questions.stop_every_copy(),
    }
}

// Answers, as the service, the live copy's turn stopped and then the copy let go.
async fn answer_copy_stopped(script: &mut ScriptedService) {
    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": "copy-turn"})
    );
    script.answer(&interrupt, &json!({}));
    let unsubscribe = script.next_sent().await;
    assert_eq!(unsubscribe["method"], "thread/unsubscribe");
    assert_eq!(unsubscribe["params"]["threadId"], COPY_THREAD);
    script.answer(&unsubscribe, &json!({"status": "unsubscribed"}));
}

// Killed by a live copy that drops its turn's id, or is only unsubscribed: no interrupt comes
// before the unsubscribe, and on a service that outlives the daemon the turn runs on unread.
#[rstest]
#[tokio::test]
async fn a_live_copy_let_go_before_its_turn_ends_has_its_turn_stopped_first(
    #[values(CopyEnd::SessionClosed, CopyEnd::DriverShutDown)] end: CopyEnd,
    #[values(LiveTurn::Running, LiveTurn::Starting)] turn: LiveTurn,
) {
    let mut session = TestCodexSession::start().await;
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), tasks.clone());
    let session_id = session.task.record.session_id;
    let params = AskSideQuestionParams {
        resume: None,
        ..resting_question(session_id)
    };
    let profile = compose_codex_profile_name(
        PermissionLevel::Readonly,
        &session.task.record.thread_settings.profile_folders,
    );
    let script = &mut session.scripted.script;

    let (asked, ()) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(side_questions.ask(&session.task.record, &params), async {
            let fork = script.next_sent().await;
            assert_eq!(fork["method"], "thread/fork");
            script.answer(
                &fork,
                &json!({
                    "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
                    "activePermissionProfile": {"id": profile},
                }),
            );
            let start = script.next_sent().await;
            assert_eq!(start["method"], "turn/start");
            if let LiveTurn::Starting = turn {
                end_copies(&side_questions, &end, session_id).await;
                script.answer(&start, &turn_reply("copy-turn"));
                answer_copy_stopped(script).await;
            } else {
                script.answer(&start, &turn_reply("copy-turn"));
            }
        })
    })
    .await
    .expect("the ask ends once its turn started");
    asked.expect("the copy takes the question");
    if let LiveTurn::Running = turn {
        tokio::time::timeout(
            SERVE_WAIT,
            futures::future::join(
                end_copies(&side_questions, &end, session_id),
                answer_copy_stopped(script),
            ),
        )
        .await
        .expect("the copy's turn is stopped and the copy let go");
    }
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("no copy's task is left");

    assert!(side_questions.lock().is_empty(), "no copy is kept");
    assert!(
        script.sent.try_recv().is_err(),
        "the daemon sent nothing more"
    );
}

// Killed by a shutdown that only stops the copies it finds: a copy asked for after it forks,
// which on the live path waits on its fork and on the resting path on a service that never answers.
#[tokio::test(flavor = "multi_thread")]
async fn a_side_question_asked_after_the_driver_stopped_every_copy_forks_nothing() {
    let mut session = TestCodexSession::start().await;
    // Bound and never served, so a copy that dials it is never answered.
    let Some(_listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.dispatch), TaskTracker::new());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id);

    side_questions.stop_every_copy();
    tokio::time::timeout(
        SERVE_WAIT,
        side_questions.ask_at_rest(
            &establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
            &params,
            Arc::new(PortRegistration::new("usage")),
        ),
    )
    .await
    .expect("the resting ask answers at once")
    .expect("a stopped copy asks nothing");
    tokio::time::timeout(
        SERVE_WAIT,
        side_questions.ask(
            &session.task.record,
            &AskSideQuestionParams {
                resume: None,
                ..resting_question(session_id)
            },
        ),
    )
    .await
    .expect("the live ask answers at once")
    .expect("a stopped copy asks nothing");

    assert!(
        session.scripted.script.sent.try_recv().is_err(),
        "the live copy was never forked"
    );
    assert!(
        lock_copy_stops(&side_questions.copy_stops)
            .copies
            .is_empty()
    );
}
