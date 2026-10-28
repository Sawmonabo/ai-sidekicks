//! A live session's close, the daemon's stop and an in-place resume that failed, through the
//! driver.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::super::CodexDriver;
use super::{LiveCodexSession, TEST_TURN, answer_stopping_request, driver_holding};
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, bind_test_listener, start_scripted_codex_service,
};
use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::side_questions::test_copies::{
    COPY_THREAD, COPY_TURN, CopyTurnEnding, POLICY_REFUSAL, read_only_profile, resting_question,
    serve_copy, serve_unended_copy,
};
use crate::driver::codex::session::side_questions::wait_for_side_question_answer;
use crate::driver::codex::session::slots::{CodexSessionSlots, closing_session_refusal};
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed, turn_reply};
use crate::driver::contract::{DriverError, SessionProcessState};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::ports::ProcessGoneListener;
use crate::driver::session_control::CloseSessionParams;
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::EngineCall;

/// How long a close may take before the test counts it as stuck.
const CLOSE_BOUND: Duration = Duration::from_secs(10);

// Real time under a timeout, the close waiting on the service's answers. Killed by dropping the
// interrupt from `close_session` and by sending it after the let-go: Codex would run the turn on
// unsubscribed.
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
// `is_interrupt_answered`, and checks the run's turn was ended as closed, once, before the
// conversation went.
async fn close_live_turn(is_interrupt_answered: bool) {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        mut scripted,
        engine,
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
                        engine.turn_ends(),
                        [EngineCall::EndTurnOnClose(run_id)],
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
    assert_eq!(engine.turn_ends(), [EngineCall::EndTurnOnClose(run_id)]);
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
    let claimed_before = new_session_id();
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
        parts.slots.claim_establishing(new_session_id()).await,
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
    let driver = driver_holding(&scripted, folder.path());
    let served = tokio::spawn(serve_unended_copy(
        listener,
        read_only_profile(folder.path()),
    ));

    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let params = resting_question(new_session_id(), folder.path());
    // Asked as the driver asks it, without waiting for the answer the stop drops.
    let answer = parts
        .side_questions
        .ask_at_rest(
            &parts.establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
            &params,
            Arc::clone(&parts.ports.usage),
        )
        .await
        .expect("the copy takes the question");
    tokio::time::timeout(CLOSE_BOUND, driver.shutdown(DaemonStopIntent::Restart))
        .await
        .expect("the stop ends once the copy's turn is stopped");
    wait_for_side_question_answer(answer)
        .await
        .expect("a stopped copy delivers nothing");

    let interrupt = tokio::time::timeout(CLOSE_BOUND, served)
        .await
        .expect("the copy's turn is interrupted")
        .expect("the service served the copy");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": COPY_THREAD, "turnId": COPY_TURN})
    );
}

// Real time under a timeout, as above. Killed by answering the ask before the copy's turn ended,
// which leaves the person neither an answer nor a refusal, and by failing a turn Codex's policy
// refused as the driver's own failure.
#[tokio::test(flavor = "multi_thread")]
async fn a_side_question_codexs_policy_refuses_is_refused_once_its_turn_ended() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let driver = driver_holding(&scripted, folder.path());
    let served = tokio::spawn(serve_copy(
        listener,
        read_only_profile(folder.path()),
        CopyTurnEnding::RefusedByPolicy,
    ));
    let params = resting_question(new_session_id(), folder.path());
    let side_question_id = params.side_question_id;

    let asked = tokio::time::timeout(CLOSE_BOUND, driver.ask_side_question(params))
        .await
        .expect("the ask answers once the copy's turn ended");
    tokio::time::timeout(CLOSE_BOUND, served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");

    let Err(DriverError::Refused(refusal)) = asked else {
        panic!("a refused turn refuses the question, not {asked:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionSideQuestionRefused);
    let detail = refusal.detail.expect("the refusal names its cause");
    assert_eq!(detail["sideQuestionId"], json!(side_question_id));
    assert_eq!(detail["cause"]["cause"], "refused");
    assert_eq!(detail["cause"]["safetyCategory"], "cyberPolicy");
    assert_eq!(detail["cause"]["sentence"], POLICY_REFUSAL);
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

/// What held a gone session's slot each time the queue heard its process gone.
struct HeardGone {
    slots: Arc<CodexSessionSlots>,
    holders: Mutex<Vec<Option<CodexSessionSlotState>>>,
}

impl ProcessGoneListener for HeardGone {
    fn process_gone(&self, session_id: SessionId) {
        lock(&self.holders).push(self.slots.describe_holder(session_id));
    }
}

/// Why a recovery's resume in place fails.
#[derive(Clone, Copy, Debug)]
enum ResumeFailure {
    /// The live service refuses it.
    Refused,
    /// The service went down after it came back, before the resume reached it.
    ServiceLost,
}

// Killed by a resume the live service refused that keeps the session's record, or tells the queue
// nothing: the session reads live on a conversation its service never loaded, and the queue keeps
// it. Killed too by letting the record go when the service went down under the resume: the
// person's restart after the crash loop would find no conversation to resume.
#[rstest]
#[case::refused(ResumeFailure::Refused)]
#[case::service_lost(ResumeFailure::ServiceLost)]
#[tokio::test]
async fn a_conversation_not_resumed_in_place_reads_down_and_tells_the_queue(
    #[case] failure: ResumeFailure,
) {
    let LiveCodexSession {
        driver,
        session_id,
        mut scripted,
        ..
    } = LiveCodexSession::idle().await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let heard = Arc::new(HeardGone {
        slots: Arc::clone(&parts.slots),
        holders: Mutex::default(),
    });
    assert!(
        parts
            .ports
            .process_gone
            .register(Arc::clone(&heard) as Arc<dyn ProcessGoneListener>)
            .is_ok()
    );
    let service = Arc::clone(&scripted.service);
    let generation = parts.recovery.owe_resumes(&service);
    let recovering = parts
        .recovery
        .recover(&service, CodexServiceRecoveryCause::Crash, generation);
    if let ResumeFailure::ServiceLost = failure {
        scripted.publish_crash_loop();
    }
    let mut recovering = std::pin::pin!(recovering);
    tokio::time::timeout(CLOSE_BOUND, async {
        loop {
            tokio::select! {
                () = &mut recovering => break,
                sent = scripted.script.next_sent() => match sent["method"].as_str() {
                    Some("thread/resume") => scripted.script.send(&json!({
                        "jsonrpc": "2.0",
                        "id": sent["id"],
                        "error": {"code": -32600, "message": "no rollout found for the thread"},
                    })),
                    Some("thread/unsubscribe") => {
                        scripted
                            .script
                            .answer(&sent, &json!({"status": "unsubscribed"}));
                    }
                    Some("account/rateLimits/read") => {
                        scripted.script.answer(&sent, &json!({"rateLimits": null}));
                    }
                    _ => scripted.script.answer(&sent, &json!({})),
                },
            }
        }
    })
    .await
    .expect("the recovery ends");

    let is_attached = service
        .attached_sessions()
        .iter()
        .any(|inbound| inbound.session_id() == session_id);
    match failure {
        ResumeFailure::Refused => {
            assert_eq!(*lock(&heard.holders), [None]);
            assert!(!is_attached, "a refused resume lets the record go");
        }
        ResumeFailure::ServiceLost => {
            assert_eq!(*lock(&heard.holders), [Some(CodexSessionSlotState::Live)]);
            assert!(is_attached, "the record stays for the person's restart");
        }
    }
    assert_eq!(
        driver.session_process_state(session_id),
        SessionProcessState::Down
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
