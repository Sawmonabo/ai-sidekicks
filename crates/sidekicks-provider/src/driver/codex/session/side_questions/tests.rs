use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use interprocess::local_socket::tokio::Listener;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use super::CodexSideQuestions;
use super::test_copies::{
    ANSWER, COPY_THREAD, COPY_TURN, STORED_THREAD, accept_copy, read_only_profile,
    resting_question, serve_copy, serve_unended_copy,
};
use crate::driver::codex::permission_level::compose_codex_profile_name;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::test_service::{
    bind_test_listener, next_socket_request, send_on_socket,
};
use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_reply};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::session_control::AskSideQuestionParams;
use crate::port::registration::PortRegistration;

/// How long the test waits for the copy to be served and let go.
const SERVE_WAIT: Duration = Duration::from_secs(10);

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
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));
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
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let session_id = session.task.record.session_id;
    let params = resting_question(session_id, Path::new("/"));
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
    asked.expect("the copy takes the question");
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
                ..resting_question(session_id, Path::new("/"))
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
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
}
