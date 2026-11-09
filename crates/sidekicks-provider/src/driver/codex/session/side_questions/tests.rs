use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use interprocess::local_socket::tokio::Listener;
use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use super::test_copies::{
    ANSWER, COPY_THREAD, COPY_TURN, CopyTurnEnding, STORED_THREAD, accept_copy, read_only_profile,
    resting_question, resting_session_ask, serve_copy, serve_unended_copy, serve_unprofiled_copy,
};
use super::{
    CodexSideQuestions, THREAD_FORK_METHOD, request_copy_fork, start_turn,
    wait_for_side_question_answer,
};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::permission_level::{CodexProfileFolders, compose_codex_profile_name};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, bind_test_listener, next_socket_request, send_on_socket,
    test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::test_fixture::{
    TestCodexSession, test_thread_settings, turn_reply,
};
use crate::driver::codex::thread::settings::tool_servers::CODEX_DAEMON_TOOL_SERVER_NAMES;
use crate::driver::codex::thread::settings::{
    CodexThreadSettings, MCP_SERVERS_KEY, compose_codex_thread_start_params,
};
use crate::driver::codex::thread::view::{
    THREAD_START_METHOD, assert_active_permission_profile, read_thread,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::session_control::AskSideQuestionParams;
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::tool_server_name::DAEMON_HOOKS_TOOL_SERVER_NAME;

/// How long the test waits for the copy to be served and let go.
const SERVE_WAIT: Duration = Duration::from_secs(10);

// Killed by refusing a session with no live record, as before it was built, by forking anything
// but the stored conversation the resume names, under the read-only profile, asking nothing, and
// by answering the ask with no text or another than the one published.
#[tokio::test(flavor = "multi_thread")]
async fn a_side_question_on_a_resting_session_forks_its_stored_conversation_and_answers() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));
    let profile = read_only_profile(folder.path());
    let served = tokio::spawn(serve_copy(
        listener,
        profile.clone(),
        CopyTurnEnding::Answered,
    ));

    let answer = side_questions
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
    let answered = wait_for_side_question_answer(answer)
        .await
        .expect("the question is answered");

    assert_eq!(fork["threadId"], STORED_THREAD);
    assert_eq!(fork["ephemeral"], true);
    assert_eq!(fork["excludeTurns"], true);
    assert_eq!(fork["permissions"], profile.as_str());
    assert_eq!(fork["approvalPolicy"], "never");
    let answers: Vec<String> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionEvent")
        .map(|delivery| {
            let payload = delivery.payload.expect("a session row carries its payload");
            assert_eq!(payload["sessionId"], session_id.to_string());
            payload["answer"]
                .as_str()
                .expect("an answer is text")
                .to_owned()
        })
        .collect();
    assert_eq!(answers, [ANSWER]);
    assert_eq!(
        answered.map(FreeFormText::into_string).as_deref(),
        Some(ANSWER)
    );
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

// Killed by a session ask's copy that keeps the session's folder trusted, so the person's project
// rules and hooks load in it, by one that carries a daemon entry or a sandbox, and by an answer
// drawn on the asked session's stream.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_ask_copy_runs_untrusted_with_no_daemon_entry_and_answers_only_its_asker() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let params = resting_session_ask(session.task.record.session_id, Path::new("/"));
    let profile = read_only_profile(folder.path());
    let served = tokio::spawn(serve_copy(
        listener,
        profile.clone(),
        CopyTurnEnding::Answered,
    ));

    let answer = side_questions
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
    let answered = wait_for_side_question_answer(answer)
        .await
        .expect("the question is answered");

    assert_eq!(fork["permissions"], profile.as_str());
    assert!(
        !fork.contains_key("sandbox"),
        "a profile is never combined with a sandbox"
    );
    assert_eq!(fork["approvalPolicy"], "never");
    let copy_folder = fork["cwd"].as_str().expect("the fork names its folder");
    assert_eq!(
        fork["config"]["projects"],
        json!({ copy_folder: {"trust_level": "untrusted"} })
    );
    let servers = &fork["config"][MCP_SERVERS_KEY];
    for name in CODEX_DAEMON_TOOL_SERVER_NAMES
        .iter()
        .chain([&DAEMON_HOOKS_TOOL_SERVER_NAME])
    {
        assert!(servers.get(name).is_none(), "the copy holds {name}");
    }
    assert_eq!(
        answered.map(FreeFormText::into_string).as_deref(),
        Some(ANSWER)
    );
    assert!(
        !session
            .engine
            .deliveries()
            .iter()
            .any(|delivery| delivery.kind == "sessionEvent"),
        "the answer reached the asked session's stream"
    );
}

// Killed by dropping the profile check on the copy's fork: the copy would start its turn under
// whatever Codex runs it with.
#[tokio::test(flavor = "multi_thread")]
async fn a_copy_fork_whose_reply_names_no_permission_profile_is_refused_and_dropped() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let side_questions =
        CodexSideQuestions::new(Arc::clone(&session.engine) as _, TaskTracker::new());
    let params = resting_session_ask(session.task.record.session_id, Path::new("/"));
    let served = tokio::spawn(serve_unprofiled_copy(listener));

    let refused = tokio::time::timeout(
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
    .expect("the ask answers once the fork replied");
    let later = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");

    assert!(matches!(refused, Err(CodexError::Transport { .. })));
    assert!(later.is_empty(), "the copy asked for more: {later:?}");
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
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
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));
    let served = tokio::spawn(serve_unended_copy(
        listener,
        read_only_profile(folder.path()),
    ));

    let answer = side_questions
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
        CopyEnd::DriverShutDown => side_questions.stop_every_copy().await,
    }
    let interrupt = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon stops the copy's turn and lets its connection go")
        .expect("the service served the copy");
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("the copy's task ends");
    wait_for_side_question_answer(answer)
        .await
        .expect("a stopped copy delivers nothing");

    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": COPY_TURN})
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
    let read = next_socket_request(&mut socket).await;
    assert_eq!(read["method"], "config/read");
    send_on_socket(
        &mut socket,
        json!({"id": read["id"], "result": {"config": {}, "origins": {}}}),
    )
    .await;
    let fork = next_socket_request(&mut socket).await;
    assert_eq!(fork["method"], "thread/fork");
    if let HeldReply::TurnStart = held {
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
        reached
            .send(())
            .expect("the test waits for the turn's start");
        release.await.expect("the test releases the turn's start");
        send_on_socket(
            &mut socket,
            json!({"id": turn["id"], "result": {"turn": {"id": COPY_TURN, "items": [],
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
            send_on_socket(&mut socket, json!({"id": request["id"], "result": {}})).await;
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
        "params": {"threadId": COPY_THREAD, "turnId": COPY_TURN},
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
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));
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
    wait_for_side_question_answer(asked.expect("a copy let go before its turn asks nothing more"))
        .await
        .expect("a copy let go delivers nothing");
    let later = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("no copy's task is left");

    assert_eq!(Value::from(later), sent_after);
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
}

// Killed by entering the live copy only once its fork answered: the close would miss it, and the
// copy would start its turn on the session's service.
#[tokio::test]
async fn a_live_copy_whose_session_closes_during_its_fork_starts_no_turn() {
    let mut session = TestCodexSession::start().await;
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = AskSideQuestionParams {
        resume: None,
        ..resting_question(session_id, Path::new("/"))
    };
    let profile = compose_codex_profile_name(
        PermissionLevel::Readonly,
        &session.task.record.thread_settings.profile_folders,
    );
    let script = &mut session.scripted.script;

    let (asked, ()) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(side_questions.ask(&session.task.record, &params), async {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.answer(&read, &json!({"config": {}, "origins": {}}));
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
    wait_for_side_question_answer(asked.expect("a copy let go before its turn asks nothing more"))
        .await
        .expect("a copy let go delivers nothing");

    assert!(
        side_questions.lock().is_empty(),
        "the copy was never entered"
    );
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
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
        CopyEnd::DriverShutDown => side_questions.stop_every_copy().await,
    }
}

// Answers, as the service, the live copy's turn stopped and then the copy let go, the copy off
// `session_id`'s routing on `service` before its turn is stopped.
async fn answer_copy_stopped(
    script: &mut ScriptedService,
    service: &CodexService,
    session_id: SessionId,
) {
    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": COPY_TURN})
    );
    assert!(
        !service
            .threads_of(&session_id)
            .iter()
            .any(|thread_id| thread_id == COPY_THREAD),
        "the stopped turn's end would reach the session"
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
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = AskSideQuestionParams {
        resume: None,
        ..resting_question(session_id, Path::new("/"))
    };
    let profile = compose_codex_profile_name(
        PermissionLevel::Readonly,
        &session.task.record.thread_settings.profile_folders,
    );
    let script = &mut session.scripted.script;
    let service = &*session.scripted.service;

    let (asked, ()) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(side_questions.ask(&session.task.record, &params), async {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.answer(&read, &json!({"config": {}, "origins": {}}));
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
                script.answer(&start, &turn_reply(COPY_TURN));
                answer_copy_stopped(script, service, session_id).await;
            } else {
                script.answer(&start, &turn_reply(COPY_TURN));
            }
        })
    })
    .await
    .expect("the ask ends once its turn started");
    let answer = asked.expect("the copy takes the question");
    if let LiveTurn::Running = turn {
        tokio::time::timeout(
            SERVE_WAIT,
            futures::future::join(
                end_copies(&side_questions, &end, session_id),
                answer_copy_stopped(script, service, session_id),
            ),
        )
        .await
        .expect("the copy's turn is stopped and the copy let go");
    }
    tasks.close();
    tokio::time::timeout(SERVE_WAIT, tasks.wait())
        .await
        .expect("no copy's task is left");
    wait_for_side_question_answer(answer)
        .await
        .expect("a stopped copy delivers nothing");

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
    let side_questions =
        CodexSideQuestions::new(Arc::clone(&session.engine) as _, TaskTracker::new());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));

    side_questions.stop_every_copy().await;
    let resting = tokio::time::timeout(
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
    let live = tokio::time::timeout(
        SERVE_WAIT,
        side_questions.ask(
            &session.task.record,
            &AskSideQuestionParams {
                resume: None,
                ..resting_question(session_id, Path::new("/"))
            },
        ),
    )
    .await
    .expect("the live ask answers at once")
    .expect("a stopped copy asks nothing");
    for answer in [resting, live] {
        wait_for_side_question_answer(answer)
            .await
            .expect("a stopped copy delivers nothing");
    }

    assert!(
        session.scripted.script.sent.try_recv().is_err(),
        "the live copy was never forked"
    );
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
}

/// How long each turn of the live copy test may take on a real account.
const LIVE_TURN_DEADLINE: Duration = Duration::from_secs(300);

// On the signed-in account home `SIDEKICKS_TEST_CODEX_HOME` names, with the Codex build
// `SIDEKICKS_TEST_CODEX_PROGRAM` names, on the model `SIDEKICKS_TEST_CODEX_MODEL` names: a session
// ask's copy of a conversation in a folder the service trusts, whose project rule pre-approves
// `touch`, writes nothing, calls no tool server and leaves no conversation file of its own. Killed
// by a copy that keeps the folder trusted, where the rule lets the write through.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a signed-in account"]
async fn a_session_ask_copy_refuses_a_pre_approved_write_and_leaves_no_file() {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_HOME")
            .expect("SIDEKICKS_TEST_CODEX_HOME names a signed-in Codex home"),
    );
    let model = std::env::var("SIDEKICKS_TEST_CODEX_MODEL")
        .expect("SIDEKICKS_TEST_CODEX_MODEL names a model the account runs");
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let work = folder.path().join("work");
    let rules = work.join(".codex").join("rules");
    let command_channel = folder.path().join("command-channel");
    for made in [&rules, &command_channel] {
        std::fs::create_dir_all(made).expect("the test makes its folders");
    }
    std::fs::write(
        rules.join("pre-approved.rules"),
        "prefix_rule(pattern = [\"touch\"], decision = \"allow\")\n",
    )
    .expect("the test writes the person's pre-approval");
    let environment: Vec<(String, String)> = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let socket = folder.path().join("codex.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: home.clone(),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        test_codex_service_dependencies(
            folder.path(),
            Arc::new(TestCodexProgram {
                program: PathBuf::from(program),
                environment: environment.clone(),
            }),
            Arc::new(UnheardEvents),
            Arc::new(UnrecordedChildren),
        ),
        // Trusted for the whole service, as the person's own Codex folder trusts a project.
        vec![format!(
            "projects={{\"{}\"={{trust_level=\"trusted\"}}}}",
            work.display()
        )],
    );
    let (events, mut frames) = CodexDetachedFrames::new();
    let connection = service
        .open_detached_connection(events)
        .await
        .expect("the service starts and is dialed");
    let settings = CodexThreadSettings {
        working_directory: work.clone(),
        model,
        profile_folders: CodexProfileFolders {
            working_directory: work.clone(),
            git_common_folder: None,
            deny_paths: Vec::new(),
            command_channel_folder: command_channel,
        },
        command_environment: environment,
        ..test_thread_settings(new_session_id())
    };
    let read_only_profile =
        compose_codex_profile_name(PermissionLevel::Readonly, &settings.profile_folders);

    let ran = tokio::time::timeout(LIVE_TURN_DEADLINE, async {
        let started = connection
            .request(
                THREAD_START_METHOD,
                &compose_codex_thread_start_params(&settings, Map::new()),
            )
            .await
            .expect("the session's conversation starts");
        let session_thread = read_thread(&started, THREAD_START_METHOD)
            .expect("the start names its conversation")
            .id;
        start_turn(
            &connection,
            &session_thread,
            &work,
            "Reply with the word ready.",
        )
        .await
        .expect("the session's turn starts");
        read_live_turn(&mut frames, &session_thread).await;
        let forked = request_copy_fork(&connection, &settings, &session_thread, true)
            .await
            .expect("the copy forks");
        let copy_thread = read_thread(&forked, THREAD_FORK_METHOD)
            .expect("the fork names its copy")
            .id;
        assert_active_permission_profile(&forked, &read_only_profile, THREAD_FORK_METHOD)
            .expect("the copy runs read-only");
        start_turn(
            &connection,
            &copy_thread,
            &work,
            "Run exactly this shell command once in the working folder: touch written. Then call \
             the sidekicks tool session_list.",
        )
        .await
        .expect("the copy's turn starts");
        let items = read_live_turn(&mut frames, &copy_thread).await;
        (copy_thread, items)
    })
    .await;
    service.stop().await;
    let (copy_thread, items) = ran.expect("the turns end within their deadline");

    assert!(
        !work.join("written").exists(),
        "the copy ran the pre-approved write"
    );
    assert!(
        !items.iter().any(|item| item["type"] == "mcpToolCall"),
        "the copy called a tool server"
    );
    assert!(
        !names_file(&home.join("sessions"), &copy_thread),
        "the copy left a conversation file"
    );
}

// The items of `thread_id`'s turn that completed on `frames`, read until that turn ended.
async fn read_live_turn(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: &str,
) -> Vec<Value> {
    let mut items = Vec::new();
    while let Some((method, params)) = frames.recv().await {
        let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
        if params["threadId"] != thread_id {
            continue;
        }
        match method.as_str() {
            "item/completed" => items.push(params["item"].clone()),
            "turn/completed" => break,
            _ => {}
        }
    }
    items
}

// Whether a file at any depth under `folder` has `name` in its file name.
fn names_file(folder: &Path, name: &str) -> bool {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                names_file(&path, name)
            } else {
                entry.file_name().to_string_lossy().contains(name)
            }
        })
}
