//! A build move on an account's service never waits on another session's turn: a second service
//! starts beside the first, and each session moves to the newest once its own running reply ends;
//! a second service that failed to start is tried again at the next check, and a move toward a
//! service and its retire exclude each other.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{mpsc, oneshot, watch};

use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::service::supervisor::test_service::{
    CODEX_HOME_NAME, REQUEST_RECORD_NAME, RESUMED_TURN_NAME, TestCodexProgram,
    serve_as_codex_service_stand_in, start_scripted_account_service_in, write_codex_service_script,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::calls::CodexSessionReading;
use crate::driver::codex::session::establishment::CodexInPlaceOutcome;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
use crate::driver::codex::session::recovery::build_move::{CodexServiceRestart, MoveToward};
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::codex::session::test_fixture::relaunches::{
    RefusedRelaunchStep, TakenRelaunches,
};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, test_session_queue,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::ports::SessionRelaunchListener;
use crate::driver::session_control::{DriverResumeResult, ProviderBuildChange};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::{EngineCall, RecordingRunEngine};
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::test_store::{spawned_build, test_provider_account_id};

/// The stand-in Codex service: this test program, run by the script the second service starts as
/// Codex.
const APP_SERVER_STAND_IN: &str =
    "driver::codex::session::recovery::tests::beside_move::an_app_server_stand_in";

/// The conversation the session whose turn runs is on.
const BUSY_THREAD: &str = "thread-busy";

// Listens as Codex does, answering the second service's start. Skips unless the test's script
// started it.
#[tokio::test]
#[ignore = "run only as the build move test's Codex service"]
async fn an_app_server_stand_in() {
    serve_as_codex_service_stand_in().await;
}

// Killed by the held in-place restart taken for an account service's build move: the idle
// session is held in its slot while the other session's turn runs, so it never moves and never
// starts a turn, and the bound fails. Real processes for the second service, under a bound.
#[tokio::test(flavor = "multi_thread")]
async fn a_build_move_moves_an_idle_session_while_another_session_s_turn_runs() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    // Declared before the session, so the script ends its launches before the home goes.
    let programs = tempfile::tempdir().expect("a scratch folder is made");
    let requests = programs.path().join("requests");
    let script = write_codex_service_script(programs.path(), APP_SERVER_STAND_IN, None);
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("home");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let program = TestCodexProgram {
        program: script.path().to_owned(),
        environment: vec![
            (CODEX_HOME_NAME.to_owned(), codex_home.display().to_string()),
            (
                RESUMED_TURN_NAME.to_owned(),
                json!({"id": "turn-0", "items": [], "status": "completed"}).to_string(),
            ),
            (
                REQUEST_RECORD_NAME.to_owned(),
                requests.display().to_string(),
            ),
        ],
    };
    let session =
        TestCodexSession::start_on(start_scripted_account_service_in(folder, Arc::new(program)))
            .await;
    let first = Arc::clone(&session.scripted.service);
    let busy_session_id = new_session_id();
    let (busy, busy_items) = test_session_queue(busy_session_id);
    session
        .slots
        .claim_establishing(busy_session_id)
        .await
        .expect("the busy session's slot is free")
        .install(busy.clone());
    first.attach_session(busy.clone());
    let reading = BusyReading {
        service: Arc::clone(&first),
        posture: session.task.record.execution_posture.clone(),
    };
    // Kept for the whole test, so the turn never ends.
    let (_turn_runs, is_turn_running) = watch::channel(true);
    let (resumed, _resumed_on) = mpsc::unbounded_channel();
    tokio::spawn(run_a_busy_session(
        busy_items,
        reading,
        is_turn_running,
        resumed,
    ));
    let (session_relaunched, mut relaunches) = relaunch_listener();
    let recovery = session.recovery(
        programs.path(),
        Arc::new(PortRegistration::new("reviewer denial")),
        Arc::new(PortRegistration::new("process gone")),
        session_relaunched,
    );
    let TestCodexSession {
        scripted,
        mut task,
        engine,
        run_start,
        daemon_turn_bindings,
        ..
    } = session;
    tokio::spawn(let_conversations_go(scripted.script));
    let change = build_change("0.163.0", "0.164.0");

    let flow = async {
        task.drive(recovery.restart_and_wait(&first, CodexServiceRestart::Beside(Some(change))))
            .await
            .expect("the second service starts");
        task.drive(next_relaunch(&mut relaunches)).await;
        let session_id = task.record.session_id;
        let binding_id = task
            .record
            .binding_id
            .clone()
            .expect("the move recorded its binding");
        let run_id = new_run_id();
        task.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: binding_id.clone(),
                agent_id: daemon_turn_bindings.agent_id,
                step_bound: None,
            },
        );
        daemon_turn_bindings.open_on(binding_id.clone());
        let inbound = task.record.inbound.clone();
        let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
        let started = task
            .drive(run_start.start_turn(
                &inbound,
                run_id,
                binding_id,
                turn_request(),
                None,
                &deadline,
            ))
            .await;
        // The notice goes out on the move's own task once the resume settled, while the
        // session's task takes what the second service sends meanwhile.
        task.drive(wait_for_build_notice(&engine, "0.163.0", "0.164.0"))
            .await;
        started
    };
    let started = tokio::time::timeout(Duration::from_secs(60), Box::pin(flow))
        .await
        .expect("the idle session moves, is told and starts its turn while the other's runs");

    started.expect("the idle session's turn starts on the second service");
    assert!(
        !Arc::ptr_eq(&task.record.service, &first),
        "the idle session left the first service"
    );
    assert_eq!(
        started_turn_threads(&requests),
        [TEST_THREAD],
        "the second service took the idle session's turn"
    );
    assert!(
        first
            .attached_sessions()
            .iter()
            .any(|attached| attached.session_id() == busy_session_id),
        "the session whose turn runs stays on the first service"
    );
}

// Waits until the run engine took a session notice of a build move from `from_version` to
// `to_version`.
async fn wait_for_build_notice(engine: &RecordingRunEngine, from_version: &str, to_version: &str) {
    engine
        .wait_until(|calls| {
            calls
                .iter()
                .any(|call| {
                    matches!(call, EngineCall::Deliver(delivery)
                    if delivery.kind == "sessionNotice"
                        && delivery.payload.as_ref().is_some_and(|payload| {
                            let payload = payload.to_string();
                            payload.contains(from_version) && payload.contains(to_version)
                        }))
                })
                .then_some(())
        })
        .await;
}

// A build move from `from_version` to `to_version`.
fn build_change(from_version: &str, to_version: &str) -> ProviderBuildChange {
    ProviderBuildChange {
        from_version: from_version.to_owned(),
        to_version: to_version.to_owned(),
    }
}

// The session relaunch port, registered with a listener that hears each relaunch step on the
// receiver.
fn relaunch_listener() -> (
    Arc<PortRegistration<Arc<dyn SessionRelaunchListener>>>,
    mpsc::UnboundedReceiver<String>,
) {
    let (heard, relaunches) = mpsc::unbounded_channel();
    let session_relaunched = Arc::new(PortRegistration::new("session relaunched"));
    let relaunched: Arc<dyn SessionRelaunchListener> = Arc::new(TakenRelaunches {
        heard: Box::new(move |step| {
            let _unheard = heard.send(step);
        }),
        refused: RefusedRelaunchStep::Nothing,
        legs: ResumeFunctionLegs::default(),
    });
    session_relaunched
        .register(relaunched)
        .expect("the port registers once");
    (session_relaunched, relaunches)
}

// Waits for the next relaunch the listener heard.
async fn next_relaunch(relaunches: &mut mpsc::UnboundedReceiver<String>) {
    while let Some(step) = relaunches.recv().await {
        if step.starts_with("relaunched") {
            return;
        }
    }
}

// Killed by a move whose target is fixed when it begins: the session whose turn runs through two
// build moves goes, once idle, to the service the first move started, which the second move
// retired once the idle session left it, and is left on the first service. Real processes for the
// second and third services, under a bound.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_busy_through_two_build_moves_moves_to_the_newest_service_once_idle() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    // Declared before the session, so the script ends its launches before the home goes.
    let programs = tempfile::tempdir().expect("a scratch folder is made");
    let script = write_codex_service_script(programs.path(), APP_SERVER_STAND_IN, None);
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("home");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let program = TestCodexProgram {
        program: script.path().to_owned(),
        environment: vec![
            (CODEX_HOME_NAME.to_owned(), codex_home.display().to_string()),
            (
                RESUMED_TURN_NAME.to_owned(),
                json!({"id": "turn-0", "items": [], "status": "completed"}).to_string(),
            ),
        ],
    };
    let session =
        TestCodexSession::start_on(start_scripted_account_service_in(folder, Arc::new(program)))
            .await;
    let first = Arc::clone(&session.scripted.service);
    let busy_session_id = new_session_id();
    let (busy, busy_items) = test_session_queue(busy_session_id);
    session
        .slots
        .claim_establishing(busy_session_id)
        .await
        .expect("the busy session's slot is free")
        .install(busy.clone());
    first.attach_session(busy.clone());
    let reading = BusyReading {
        service: Arc::clone(&first),
        posture: session.task.record.execution_posture.clone(),
    };
    let (turn_runs, is_turn_running) = watch::channel(true);
    let (resumed, mut resumed_on) = mpsc::unbounded_channel();
    tokio::spawn(run_a_busy_session(
        busy_items,
        reading,
        is_turn_running,
        resumed,
    ));
    let (session_relaunched, mut relaunches) = relaunch_listener();
    let recovery = session.recovery(
        programs.path(),
        Arc::new(PortRegistration::new("reviewer denial")),
        Arc::new(PortRegistration::new("process gone")),
        session_relaunched,
    );
    let TestCodexSession {
        scripted,
        mut task,
        engine,
        ..
    } = session;
    tokio::spawn(let_conversations_go(scripted.script));
    let services = Arc::clone(&recovery.dependencies.services);
    let home_service = || {
        services
            .home_service(&first.home().codex_home)
            .expect("a service holds the home")
    };

    let flow = async {
        let first_move = CodexServiceRestart::Beside(Some(build_change("0.163.0", "0.164.0")));
        task.drive(recovery.restart_and_wait(&first, first_move))
            .await
            .expect("the second service starts");
        task.drive(next_relaunch(&mut relaunches)).await;
        let second = home_service();
        let second_move = CodexServiceRestart::Beside(Some(build_change("0.164.0", "0.165.0")));
        task.drive(recovery.restart_and_wait(&second, second_move))
            .await
            .expect("the third service starts");
        task.drive(next_relaunch(&mut relaunches)).await;
        let third = home_service();
        turn_runs.send_replace(false);
        let resumed = resumed_on.recv().await.expect("the busy session resumes");
        // Told once the first let it go: from the build it ran to the newest.
        task.drive(wait_for_build_notice(&engine, "0.163.0", "0.165.0"))
            .await;
        (second, third, resumed)
    };
    let (second, third, resumed) = tokio::time::timeout(Duration::from_secs(60), Box::pin(flow))
        .await
        .expect("the busy session moves once its turn ends");

    assert!(!Arc::ptr_eq(&second, &first) && !Arc::ptr_eq(&third, &second));
    assert_eq!(
        resumed,
        third.id(),
        "the busy session resumed on a service other than the newest"
    );
    assert!(
        third
            .attached_sessions()
            .iter()
            .any(|attached| attached.session_id() == busy_session_id),
        "the busy session is not on the newest service"
    );
    assert!(
        !first
            .attached_sessions()
            .iter()
            .any(|attached| attached.session_id() == busy_session_id),
        "the busy session is left on the first service"
    );
}

// Each check moves a service not on the installed build, so one whose second service failed to
// start is moved again at the next. Killed by a check that moves a service already on the
// installed build again, compared by the printed text rather than the parsed version, and by one
// that moves a service whose version did not parse, at every check for good.
#[tokio::test]
async fn a_build_move_whose_second_service_failed_to_start_is_tried_again_at_the_next_check() {
    let session = TestCodexSession::start().await;
    let first = Arc::clone(&session.scripted.service);
    session.scripted.report_version("0.163.0");
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let recovery = session.recovery(
        folder.path(),
        Arc::new(PortRegistration::new("reviewer denial")),
        Arc::new(PortRegistration::new("process gone")),
        Arc::new(PortRegistration::new("session relaunched")),
    );
    let change = build_change("0.163.0", "0.164.0");

    recovery.move_to_provider_build(&change);
    let is_first_check_moving = recovery.is_restarting(first.id());
    let failed = recovery
        .restart_and_wait(&first, CodexServiceRestart::Beside(None))
        .await;
    recovery.move_to_provider_build(&change);
    let is_next_check_moving = recovery.is_restarting(first.id());
    let failed_again = recovery
        .restart_and_wait(&first, CodexServiceRestart::Beside(None))
        .await;
    session.scripted.report_version("codex-cli 0.164.0");
    recovery.move_to_provider_build(&change);
    let is_installed_build_moving = recovery.is_restarting(first.id());
    session.scripted.report_version("codex-cli dev");
    recovery.move_to_provider_build(&change);
    let is_unparsed_build_moving = recovery.is_restarting(first.id());

    assert!(is_first_check_moving, "the first check moved nothing");
    assert!(failed.is_err(), "the second service started");
    assert!(
        is_next_check_moving,
        "the next check left the service on the old build"
    );
    assert!(failed_again.is_err(), "the second service started");
    assert!(
        !is_installed_build_moving,
        "a service on the installed build moved again"
    );
    assert!(
        !is_unparsed_build_moving,
        "a service whose version did not parse moved"
    );
    assert!(
        first
            .attached_sessions()
            .iter()
            .any(|attached| attached.session_id() == session.task.record.session_id),
        "the session left the service that kept serving"
    );
}

// A move toward a service and its retire never both go ahead: a service a move is under way
// toward is not marked retiring, and a move toward one retiring is refused. Killed by a retire
// that leaves out the moves toward the service, and by a move that leaves out its retire.
#[tokio::test]
async fn a_move_toward_a_service_and_its_retire_exclude_each_other() {
    let session = TestCodexSession::start().await;
    let first = Arc::clone(&session.scripted.service);
    first.detach_session(&session.task.record.session_id);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let recovery = session.recovery(
        folder.path(),
        Arc::new(PortRegistration::new("reviewer denial")),
        Arc::new(PortRegistration::new("process gone")),
        Arc::new(PortRegistration::new("session relaunched")),
    );

    let toward = MoveToward::begin(&recovery, &first).expect("nothing retires the service yet");
    recovery.retire_when_empty(&first);
    let is_retiring_under_move = recovery.lock().retiring.contains(&first.id());
    drop(toward);
    recovery.retire_when_empty(&first);
    let is_move_begun = MoveToward::begin(&recovery, &first).is_some();

    assert!(
        !is_retiring_under_move,
        "the service retires while a move toward it is under way"
    );
    assert!(!is_move_begun, "a move began toward a service retiring");
}

// What the session whose turn runs reads as.
struct BusyReading {
    service: Arc<CodexService>,
    posture: ExecutionPosture,
}

// Runs the session whose turn runs while `is_turn_running` holds: each read says whether a turn
// is in flight, each wait for its turns is kept unanswered until the turn ends, and a resume is
// answered as resumed on the service it names, which `resumed_on` is told.
async fn run_a_busy_session(
    mut items: mpsc::UnboundedReceiver<CodexSessionInbound>,
    mut reading: BusyReading,
    mut is_turn_running: watch::Receiver<bool>,
    resumed_on: mpsc::UnboundedSender<CodexServiceId>,
) {
    let mut waits = Vec::new();
    loop {
        let item = tokio::select! {
            item = items.recv() => item,
            Ok(()) = is_turn_running.changed() => {
                // A wait whose answer is dropped reads as over.
                waits.clear();
                continue;
            }
        };
        let Some(item) = item else {
            return;
        };
        let is_turn_in_flight = *is_turn_running.borrow();
        match item {
            CodexSessionInbound::Call(CodexSessionCall::ReadSession { reply, .. }) => {
                let _unheard = reply.send(CodexSessionReading {
                    service: Arc::clone(&reading.service),
                    connection: reading.service.connection(),
                    thread_id: BUSY_THREAD.to_owned(),
                    is_turn_in_flight,
                    live_turn_runs: Vec::new(),
                    is_thread_loaded: true,
                    execution_posture: reading.posture.clone(),
                    provider_account_id: test_provider_account_id(),
                    auto_memory: None,
                });
            }
            CodexSessionInbound::Call(CodexSessionCall::WaitForTurns { reply, .. }) => {
                let (answer, wait) = oneshot::channel();
                if is_turn_in_flight {
                    waits.push(answer);
                }
                let _unheard = reply.send(wait);
            }
            CodexSessionInbound::Call(CodexSessionCall::ResumeInPlace { resume, reply }) => {
                let _unheard = resumed_on.send(resume.service.id());
                reading.service = Arc::clone(&resume.service);
                let _unheard = reply.send(CodexInPlaceOutcome {
                    result: DriverResumeResult::Resumed {
                        binding_id: resume.binding_id,
                        session_position: SafeInt::from_usize(0),
                        resume_handle: NonEmptyText::new(BUSY_THREAD.to_owned())
                            .expect("the conversation's id is text"),
                        spawned_version: spawned_build("0.165.0", "/opt/codex/bin/codex"),
                        runs: Vec::new(),
                    },
                    is_service_lost: false,
                });
            }
            // The move asks the session nothing else.
            CodexSessionInbound::Frame { .. }
            | CodexSessionInbound::Ask { .. }
            | CodexSessionInbound::AsksWithdrawn { .. }
            | CodexSessionInbound::HeldThread { .. }
            | CodexSessionInbound::Call(_)
            | CodexSessionInbound::Lifecycle(_)
            | CodexSessionInbound::AccountMoved(_)
            | CodexSessionInbound::SideQuestionReleased { .. }
            | CodexSessionInbound::ExportedResponse(_) => {}
        }
    }
}

// Answers, as the first service, a conversation's let-go with nothing loaded there any more.
async fn let_conversations_go(mut script: ScriptedService) {
    loop {
        let sent = script.next_sent().await;
        match sent["method"].as_str() {
            Some("thread/loaded/list") => script.answer(&sent, &json!({"data": []})),
            _ => script.answer(&sent, &json!({})),
        }
    }
}

// A turn of one message at the session's own settings.
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
        level: None,
    }
}

// The conversation of each `turn/start` the stand-in recorded in `requests`, in order.
fn started_turn_threads(requests: &Path) -> Vec<String> {
    std::fs::read_to_string(requests)
        .expect("the second service's requests were recorded")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a request is JSON"))
        .filter(|request| request["method"] == "turn/start")
        .map(|request| {
            request["params"]["threadId"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}
