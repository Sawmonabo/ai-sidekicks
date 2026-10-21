use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::session::controls::methods::PermissionLevel;

use crate::provider::driver::codex::run::routes::CodexRunBinding;
use crate::provider::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::provider::driver::codex::run::start::record::CodexTurnRequest;
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::provider::driver::codex::session::state::CodexTurnMessage;
use crate::provider::driver::codex::session::test_session::{
    TestCodexSession, new_run_id, turn_reply, turn_started,
};

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
// reply-first order), and the open of a turn Codex started by itself taking a turn a run's start
// claims (the frame-first order).
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
        let start = run_start.start_turn(&inbound, run_id, binding_id, turn_request(), &deadline);
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
    }
}
