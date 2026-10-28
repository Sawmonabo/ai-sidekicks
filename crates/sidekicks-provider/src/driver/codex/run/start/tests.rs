use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::steer::steer_codex_run;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, turn_completed, turn_reply, turn_started,
};
use crate::driver::contract::DriverError;
use crate::driver::test_registry::new_run_id;

/// How long a test waits before it counts a hold on the session's task as a deadlock.
const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

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

// Kills: the starting run left among the runs whose turn is starting after Codex answered (the
// reply-first order), the open of a turn Codex started by itself taking a turn a run's start
// claims (the frame-first order), and a fork the conversation owes making a start wait out a turn
// Codex started by itself rather than refusing it at once.
#[tokio::test]
async fn a_turn_codex_starts_while_a_run_starts_is_that_runs_in_either_order() {
    for is_frame_first in [true, false] {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        let run_id = new_run_id();
        let session_id = session.task.record.session_id;
        session.task.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: binding_id.clone(),
                agent_id: session.daemon_turn_bindings.agent_id,
                step_bound: None,
            },
        );
        session.daemon_turn_bindings.open_on(binding_id.clone());
        let run_start = Arc::clone(&session.run_start);
        let inbound = session.task.record.inbound.clone();
        let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
        let start = run_start.start_turn(
            &inbound,
            run_id,
            binding_id,
            turn_request(),
            None,
            &deadline,
        );
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let flow = async {
            task.handle_next().await;
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "turn/start");
            if is_frame_first {
                script.send(&turn_started("turn-9"));
                task.handle_next().await;
            }
            script.answer(&sent, &turn_reply("turn-9"));
            task.handle_next().await;
            if !is_frame_first {
                script.send(&turn_started("turn-9"));
                task.handle_next().await;
            }
        };
        let (started, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async { tokio::join!(start, flow) }),
        )
        .await
        .expect("the start and its frames settle");
        started.expect("the run's turn starts");
        let record = &session.task.record;
        assert_eq!(
            record.active_turn_run("turn-9"),
            Some(run_id),
            "the turn is the starting run's (frame first: {is_frame_first})"
        );
        assert!(
            record.delivery.starting_turn_run_ids.is_empty(),
            "no run waits as starting once Codex answered (frame first: {is_frame_first})"
        );
        assert!(
            record.delivery.self_started_turn_ids.is_empty(),
            "no run of the session's own opened (frame first: {is_frame_first})"
        );
        assert!(
            session.engine.first_daemon_turn_run().is_none(),
            "the run engine started no run of the session's own (frame first: {is_frame_first})"
        );

        let record = &mut session.task.record;
        record
            .delivery
            .self_started_turn_ids
            .insert("turn-9".to_owned());
        record.is_config_fork_owed = true;
        let next_binding_id = session.record_binding().await;
        let next = run_start.start_turn(
            &inbound,
            new_run_id(),
            next_binding_id,
            turn_request(),
            None,
            &deadline,
        );
        let (refused, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async { tokio::join!(next, session.task.handle_next()) }),
        )
        .await
        .expect("the start is answered at once");
        assert!(
            matches!(refused, Err(CodexError::SessionTurnInFlight { .. })),
            "a turn Codex started refuses the start before an owed fork waits on it: {refused:?}"
        );
    }
}

// Kills: the turn's request bounded by the whole turn-start timeout rather than what is left of
// the start's own deadline, which holds the session's turn starts that long.
#[tokio::test]
async fn a_turn_start_codex_leaves_unanswered_fails_at_the_starts_deadline() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    let run_start = Arc::clone(&session.run_start);
    let inbound = session.task.record.inbound.clone();
    let deadline = CodexTurnEndDeadline::new(Duration::from_millis(200));
    let start = run_start.start_turn(
        &inbound,
        new_run_id(),
        binding_id,
        turn_request(),
        None,
        &deadline,
    );
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let flow = async {
        task.handle_next().await;
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/start");
        task.handle_next().await;
    };
    let (started, ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(start, flow) }),
    )
    .await
    .expect("the start ends at its deadline");
    assert!(
        matches!(
            started,
            Err(CodexError::Unanswered {
                cause: CodexUnansweredCause::Deadline { .. },
                ..
            })
        ),
        "{started:?}"
    );
}

// Kills: the interrupt on a withdrawal dropped, which leaves the turn Codex started running and
// answers the start as started, and the start answered before the turn's interrupt.
#[tokio::test]
async fn a_start_withdrawn_in_flight_interrupts_the_turn_codex_named() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    session.task.run_routes.bind_run_delivery(
        run_id,
        CodexRunBinding {
            session_id: session.task.record.session_id,
            binding_id: binding_id.clone(),
            agent_id: session.daemon_turn_bindings.agent_id,
            step_bound: None,
        },
    );
    let run_start = Arc::clone(&session.run_start);
    let inbound = session.task.record.inbound.clone();
    let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
    let start = run_start.start_turn(
        &inbound,
        run_id,
        binding_id,
        turn_request(),
        None,
        &deadline,
    );
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service_side = async {
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/start");
        assert!(
            run_start.withdraw_turn_start(run_id),
            "the run's start is in flight"
        );
        script.answer(&sent, &turn_reply("turn-9"));
        let interrupt = script.next_sent().await;
        assert_eq!(interrupt["method"], "turn/interrupt");
        assert_eq!(interrupt["params"]["turnId"], "turn-9");
        script.answer(&interrupt, &json!({}));
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "thread/backgroundTerminals/list");
        script.answer(&listed, &json!({"data": []}));
        script.send(&turn_completed(TEST_THREAD, "turn-9", "interrupted"));
    };
    let (started, ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(task.drive(start), service_side) }),
    )
    .await
    .expect("the start and the interrupt settle");
    let Err(CodexError::TurnWithdrawn { run_id: withdrawn }) = started else {
        panic!("the start is withdrawn: {started:?}");
    };
    assert_eq!(withdrawn, run_id);
}

/// The request a person's message went out in, and the refusal Codex answers it with.
#[derive(Clone, Copy, Debug)]
enum InputRefusal {
    /// `turn/start` refused past Codex's input limit.
    StartTooLarge,
    /// `turn/steer` refused past Codex's input limit.
    SteerTooLarge,
    /// `turn/start` refused with the limit's `data` under another code.
    StartOtherCode,
    /// `turn/start` refused as `-32602` for another input error.
    StartOtherInputError,
}

// Kills: the `-32602` check dropped (the other code is refused as too large), the
// `input_error_code` check dropped (the other input error is), the error answer's `data` not
// carried from the connection (neither request is), and either request's refusal left unread.
#[rstest]
#[case::start_too_large(InputRefusal::StartTooLarge)]
#[case::steer_too_large(InputRefusal::SteerTooLarge)]
#[case::start_other_code(InputRefusal::StartOtherCode)]
#[case::start_other_input_error(InputRefusal::StartOtherInputError)]
#[tokio::test]
async fn a_message_past_codexs_input_limit_is_refused_as_too_large(#[case] refusal: InputRefusal) {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    let run_start = Arc::clone(&session.run_start);
    let inbound = session.task.record.inbound.clone();
    let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
    let (code, input_error_code) = match refusal {
        InputRefusal::StartTooLarge | InputRefusal::SteerTooLarge => (-32602, "input_too_large"),
        InputRefusal::StartOtherCode => (-32600, "input_too_large"),
        InputRefusal::StartOtherInputError => (-32602, "input_empty"),
    };
    let is_steer = matches!(refusal, InputRefusal::SteerTooLarge);
    if is_steer {
        session
            .task
            .record
            .add_active_turn("turn-1".to_owned(), run_id);
    }
    let request = async {
        if is_steer {
            let message_id =
                QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
            steer_codex_run(&inbound, run_id, None, message_id, async { Ok(Vec::new()) })
                .await
                .map(|_acknowledged| ())
        } else {
            run_start
                .start_turn(
                    &inbound,
                    run_id,
                    binding_id,
                    turn_request(),
                    None,
                    &deadline,
                )
                .await
                .map_err(DriverError::from)
        }
    };
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let flow = async {
        task.handle_next().await;
        let sent = script.next_sent().await;
        let method = if is_steer { "turn/steer" } else { "turn/start" };
        assert_eq!(sent["method"], method);
        script.send(&json!({
            "jsonrpc": "2.0",
            "id": sent["id"],
            "error": {
                "code": code,
                "message": "Input exceeds the maximum length of 1048576 characters.",
                "data": {
                    "input_error_code": input_error_code,
                    "max_chars": 1_048_576,
                    "actual_chars": 1_048_577,
                },
            },
        }));
        if !is_steer {
            task.handle_next().await;
        }
    };
    let (refused, ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(request, flow) }),
    )
    .await
    .expect("the request is answered");
    let refused = refused.expect_err("Codex refused the message");
    match refusal {
        InputRefusal::StartTooLarge | InputRefusal::SteerTooLarge => {
            let DriverError::Refused(refused) = refused else {
                panic!("the message is refused as too large: {refused:?}");
            };
            assert_eq!(refused.code, RefusalCode::SessionMessageTooLarge);
            assert_eq!(
                refused.detail.map(Value::Object),
                Some(json!({"limit": 1_048_576, "observed": 1_048_577}))
            );
        }
        InputRefusal::StartOtherCode | InputRefusal::StartOtherInputError => assert!(
            matches!(refused, DriverError::Internal(_)),
            "a refusal that is not the input limit stays Codex's: {refused:?}"
        ),
    }
}
