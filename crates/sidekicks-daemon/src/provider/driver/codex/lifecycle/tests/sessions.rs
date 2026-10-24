//! A live session's close and the daemon's stop, through the driver.

use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;

use super::super::CodexDriver;
use super::{LiveCodexSession, TEST_TURN, answer_stopping_request};
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::tests::open_log;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::codex::permission_level::{
    CodexProfileFolders, compose_codex_profile_name,
};
use crate::provider::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::provider::driver::codex::run::start::record::CodexTurnRequest;
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, bind_test_listener, next_socket_request, send_on_socket,
    start_scripted_codex_service,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::inbound::codex_session_inbound;
use crate::provider::driver::codex::session::slots::closing_session_refusal;
use crate::provider::driver::codex::session::state::CodexTurnMessage;
use crate::provider::driver::codex::session::test_session::{
    OneFolder, TEST_THREAD, TestDaemonTurnBindings, UnreadRunStates, turn_completed, turn_reply,
};
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::session_control::{
    AskSideQuestionParams, CloseSessionParams, ResumeSessionParams,
};
use crate::provider::driver::test_registry::{new_run_id, terminal_events, test_driver_services};
use crate::session::run::engine::tests::test_engine;
use crate::session::run::epochs::ExecutionEpochs;
use crate::session::run::inbound::RunInboundDispatch;

/// How long a close may take before the test counts it as stuck.
const CLOSE_BOUND: Duration = Duration::from_secs(10);

/// The read-only copy the service forks a resting session's conversation into for a side question.
const COPY_THREAD: &str = "copy-thread";

/// The copy's one turn.
const COPY_TURN: &str = "copy-turn";

// Real time under a timeout, since the run engine writes the run's end through the database
// writer. Killed by dropping the interrupt from `close_session` and by sending it after the
// let-go: Codex would run the turn on unsubscribed.
#[tokio::test]
async fn a_close_interrupts_the_live_turn_and_ends_its_run_before_letting_the_conversation_go() {
    close_live_turn(true).await;
}

// Real time, the close waiting out its bound. Killed by dropping the `end_turn_on_close` call, and
// by dropping the close's bound on the interrupt: the run would stay `running` past its session's
// close, or the close would wait on Codex past the test's bound.
#[tokio::test]
async fn a_close_whose_interrupt_codex_never_answers_ends_its_run_as_closed_past_its_bound() {
    close_live_turn(false).await;
}

// Closes a session whose run is on a live turn, Codex answering the close's interrupt when
// `is_interrupt_answered`, and checks the run ended as closed before the conversation went.
async fn close_live_turn(is_interrupt_answered: bool) {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        mut scripted,
        database,
        ..
    } = LiveCodexSession::start(&[]).await;

    let close = driver.close_session(CloseSessionParams { session_id });
    tokio::pin!(close);
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                if sent["method"] == "thread/unsubscribe" {
                    assert_eq!(
                        terminal_events(&database, run_id),
                        [("agent.run.interrupted".to_owned(), Some(true))],
                        "the run ended as closed before its conversation was let go"
                    );
                }
                if is_interrupt_answered || sent["method"] != "turn/interrupt" {
                    answer_stopping_request(&scripted.script, &sent);
                }
                methods.push(sent);
            }
        }
    }

    assert_interrupted_before_let_go(&methods, TEST_TURN);
    assert_eq!(
        terminal_events(&database, run_id),
        [("agent.run.interrupted".to_owned(), Some(true))]
    );
}

// Real time under a timeout, as above. Killed by dropping the interrupt from `close_session` and
// by sending it after the let-go: the turn Codex names once the close began would run on.
#[tokio::test]
async fn a_close_interrupts_a_turn_whose_start_codex_answers_after_the_close_began() {
    let session = LiveCodexSession::idle().await;
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        binding_id,
        mut scripted,
        ..
    } = session;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let inbound = parts
        .slots
        .require_live(session_id)
        .expect("the session is live");
    let withdrawn = Arc::new(AtomicBool::new(false));
    let start = tokio::spawn({
        let parts = Arc::clone(&parts);
        let withdrawn = Arc::clone(&withdrawn);
        async move {
            let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
            parts
                .run_start
                .start_turn(
                    &inbound,
                    run_id,
                    binding_id,
                    turn_request(),
                    Some(withdrawn),
                    &deadline,
                )
                .await
        }
    });
    let turn_start = tokio::time::timeout(CLOSE_BOUND, scripted.script.next_sent())
        .await
        .expect("the run's turn start is sent");
    assert_eq!(turn_start["method"], "turn/start");

    let close = driver.close_session(CloseSessionParams { session_id });
    tokio::pin!(close);
    // Codex names the turn once the close withdrew the start; nothing announces the withdrawal
    // but the start's own flag, so the test yields until the close set it.
    let named = async {
        while !withdrawn.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    };
    tokio::pin!(named);
    let mut is_named = false;
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            () = &mut named, if !is_named => {
                is_named = true;
                scripted.script.answer(&turn_start, &turn_reply("turn-2"));
            }
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                answer_stopping_request(&scripted.script, &sent);
                methods.push(sent);
            }
        }
    }

    assert_interrupted_before_let_go(&methods, "turn-2");
    assert!(
        matches!(
            start.await.expect("the start's task ends"),
            Err(CodexError::TurnWithdrawn { .. })
        ),
        "the close withdrew the start before Codex named its turn"
    );
}

// Real time under a timeout, as above. A turn start the close's interrupt has been answered for,
// sent before the close claims the slot, its turn's end still on its way. Killed by leaving the
// close's mark unread where the record takes a turn's start: the start would wait for the stopped
// turn, then send `turn/start` on a conversation the close lets go, which Codex would run on.
#[tokio::test]
async fn a_turn_start_after_the_close_s_interrupt_is_refused_and_starts_no_turn() {
    let LiveCodexSession {
        driver,
        session_id,
        binding_id,
        mut scripted,
        ..
    } = LiveCodexSession::start(&[]).await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let inbound = parts
        .slots
        .require_live(session_id)
        .expect("the session is live");

    let close = driver.close_session(CloseSessionParams { session_id });
    tokio::pin!(close);
    let mut refused = None;
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                if sent["method"] == "turn/interrupt" {
                    scripted.script.answer(&sent, &json!({}));
                    let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
                    let start = parts.run_start.start_turn(
                        &inbound,
                        new_run_id(),
                        binding_id.clone(),
                        turn_request(),
                        None,
                        &deadline,
                    );
                    refused = Some(
                        tokio::time::timeout(CLOSE_BOUND, start)
                            .await
                            .expect("the start is answered before the interrupted turn ends"),
                    );
                    scripted
                        .script
                        .send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
                } else {
                    answer_stopping_request(&scripted.script, &sent);
                }
                methods.push(sent);
            }
        }
    }

    let refusal = refused
        .expect("the close interrupted the turn")
        .expect_err("the closing session refuses the start");
    assert_eq!(
        refusal.to_string(),
        closing_session_refusal(session_id).to_string()
    );
    assert_interrupted_before_let_go(&methods, TEST_TURN);
    assert!(
        !methods.iter().any(|sent| sent["method"] == "turn/start"),
        "no turn started on the closing session"
    );
}

// Real time under a timeout, as above. Killed by dropping the refusal's read from
// `claim_establishing`, by letting go only the sessions that held a record when the stop began,
// and by interrupting turns on the stop: a create after the stop began would install a record no
// one lets go, one claimed before it would keep its record, and the turn a later daemon resumes
// would be stopped.
#[tokio::test]
async fn the_daemons_stop_refuses_a_create_and_lets_go_one_claimed_before_it_without_interrupts() {
    let LiveCodexSession {
        driver,
        session_id,
        mut scripted,
        ..
    } = LiveCodexSession::start(&[]).await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let new_session =
        || SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let claimed_before = new_session();
    let create = parts
        .slots
        .claim_establishing(claimed_before)
        .await
        .expect("a create claims a free slot before the stop");

    let shutdown = driver.shutdown(DaemonStopIntent::Restart);
    tokio::pin!(shutdown);
    tokio::select! {
        biased;
        () = &mut shutdown => panic!("the stop waits for the create claimed before it"),
        () = std::future::ready(()) => {}
    }
    assert!(matches!(
        parts.slots.claim_establishing(new_session()).await,
        Err(CodexError::SessionClosed { .. })
    ));
    // The create's record, whose task has already ended.
    create.install(codex_session_inbound(claimed_before).0);
    drop(create);
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the stop ends within its bound"),
            () = &mut shutdown => break,
            sent = scripted.script.next_sent() => {
                answer_stopping_request(&scripted.script, &sent);
                methods.push(sent["method"].clone());
            }
        }
    }

    assert!(methods.contains(&json!("thread/unsubscribe")));
    assert!(!methods.contains(&json!("turn/interrupt")));
    for session_id in [session_id, claimed_before] {
        assert!(
            parts.slots.require_live(session_id).is_err(),
            "the stop let the record go"
        );
    }
}

// Real time under a timeout, as above. Killed by dropping the stop of every side question's copy
// from `shutdown`: the copy's turn would run on in a service that outlives the daemon, and the
// driver's tasks would wait for that turn's end past the test's bound.
#[tokio::test(flavor = "multi_thread")]
async fn the_daemons_stop_stops_the_turn_of_a_resting_sessions_side_question() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let database = TestDatabase::new();
    let driver = driver_holding(&scripted, folder.path(), &database).await;
    let served = tokio::spawn(serve_unended_copy(
        listener,
        read_only_profile(folder.path()),
    ));

    driver
        .ask_side_question(resting_question(folder.path()))
        .await
        .expect("the copy takes the question");
    tokio::time::timeout(CLOSE_BOUND, driver.shutdown(DaemonStopIntent::Restart))
        .await
        .expect("the stop ends once the copy's turn is stopped");

    let interrupt = tokio::time::timeout(CLOSE_BOUND, served)
        .await
        .expect("the copy's turn is interrupted")
        .expect("the service served the copy");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": COPY_TURN})
    );
}

// The composed driver on the person's own sign-in whose registry holds `scripted`'s service, every
// session running in `folder`'s `work`, its runs on an engine over `database`.
async fn driver_holding(
    scripted: &ScriptedCodexService,
    folder: &Path,
    database: &TestDatabase,
) -> CodexDriver {
    let log = open_log(database, None).await;
    let engine = test_engine(database, Arc::clone(&log.service), folder);
    let dispatch = Arc::new(RunInboundDispatch::new(
        Arc::clone(&engine),
        Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        ))),
        Arc::new(UnreadRunStates),
        log.service,
    ));
    let mut services = test_driver_services();
    services.spawn_contexts = Arc::new(OneFolder(folder.join("work")));
    services.execution_postures = Arc::new(ExecutionPostureService::new(
        folder,
        folder.join("session-token"),
    ));
    let ports = &services.ports;
    assert!(ports.run_engine.register(engine).is_ok());
    assert!(ports.inbound_dispatch.register(dispatch).is_ok());
    let agent_id = AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
    assert!(
        ports
            .daemon_turn_bindings
            .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
            .is_ok()
    );
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding(scripted);
    driver
}

// A side question on a session at rest whose stored conversation is `stored-thread`, at Ask on the
// person's own sign-in.
fn resting_question(folder: &Path) -> AskSideQuestionParams {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    AskSideQuestionParams {
        session_id,
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "What does this read?".to_owned(),
        resume: Some(ResumeSessionParams {
            session_id,
            agent_id: AgentId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an agent id"),
            resume_handle: "stored-thread".to_owned(),
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
        }),
    }
}

// The read-only profile a copy of a session running in `folder`'s `work` runs under.
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

// Serves a side question's copy as Codex through its turn's start under `profile`, and never ends
// the turn; answers the interrupt the daemon sent.
async fn serve_unended_copy(listener: Listener, profile: String) -> Value {
    let stream = listener
        .accept()
        .await
        .expect("the daemon dials the service");
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .expect("the daemon upgrades its connection");
    loop {
        let request = next_socket_request(&mut socket).await;
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"userAgent": "codex/0.163.0 (test)"}),
            Some("thread/fork") => json!({
                "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
                "activePermissionProfile": {"id": profile},
            }),
            Some("turn/start") => turn_reply(COPY_TURN),
            Some("turn/interrupt") => {
                send_on_socket(&mut socket, json!({"id": request["id"], "result": {}})).await;
                return request;
            }
            method => panic!("the copy sent {method:?}"),
        };
        send_on_socket(&mut socket, json!({"id": request["id"], "result": result})).await;
    }
}

// That `turn_id` was interrupted once, before the conversation was unsubscribed.
fn assert_interrupted_before_let_go(methods: &[Value], turn_id: &str) {
    let position = |method: &str| methods.iter().position(|sent| sent["method"] == method);
    let interrupt = position("turn/interrupt").expect("the close interrupts the turn");
    let unsubscribe = position("thread/unsubscribe").expect("the close lets the conversation go");
    assert!(
        interrupt < unsubscribe,
        "the interrupt goes before the let-go"
    );
    assert_eq!(methods[interrupt]["params"]["turnId"], turn_id);
    assert_eq!(
        methods
            .iter()
            .filter(|sent| sent["method"] == "turn/interrupt")
            .count(),
        1
    );
}

// A one-message turn.
fn turn_request() -> CodexTurnRequest {
    CodexTurnRequest {
        messages: vec![CodexTurnMessage {
            text: "Go on.".to_owned(),
            skills: Vec::new(),
            attachments: Vec::new(),
        }],
        client_message_ids: vec!["message-1".to_owned()],
        model: None,
        output_speed: None,
        output_speed_for_turn: None,
        output_schema: None,
        level: Some(PermissionLevel::Ask),
    }
}
