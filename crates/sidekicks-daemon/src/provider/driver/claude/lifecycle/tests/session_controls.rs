//! The session controls that run beside a session's own turns, reached through the driver: a side
//! question, the staged review and a run started through the driver interface.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::wire::BoolLiteral;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{resume_params, start_params};
use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::driver::claude::lifecycle::ClaudeDriver;
use crate::provider::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::provider::driver::claude::session::scripted::driver::{
    ScriptedDriver, create_params, end_turn_of,
};
use crate::provider::driver::claude::session::scripted::starts::ScriptedOneTurnRecord;
use crate::provider::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, hand_scripted_frame, settle,
};
use crate::provider::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::provider::driver::claude::session::transport::declarations::{
    ClaudeCumulativeUsageObservation, ClaudeHandshakeDeclaration, ClaudeInitializeDeclaration,
    ClaudeOfferedModel,
};
use crate::provider::driver::claude::spawn::launch::one_turn::ClaudeOneTurnReply;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::run_control::InterruptRunRequest;
use crate::provider::driver::session_control::{
    AskSideQuestionParams, CloseSessionParams, CreateSessionParams, StartReviewParams,
};
use crate::provider::driver::test_registry::{new_run_id, new_session_id};
use crate::provider::port::run_host::test_host::EngineCall;
use crate::provider::run::delivery::LateAppendableRow;
use crate::provider::run::state_entry::RunStateEntry;
use crate::provider::usage_delta_accountant::UsageAxisCounts;

// The full id the build resolves the session's `opus` to.
const FULL_MODEL_ID: &str = "claude-opus-4-7";

// A one-turn reply answering `text`, reporting `usage` where given.
fn one_turn_reply(text: &str, usage: Option<UsageAxisCounts>) -> ClaudeOneTurnReply {
    ClaudeOneTurnReply {
        text: text.to_owned(),
        provider_message_id: None,
        refusal: None,
        usage: usage.map(|cumulative| ClaudeCumulativeUsageObservation {
            named_turn_id: None,
            cumulative,
            declared_per_turn: None,
        }),
    }
}

// Input and output counts.
fn counts(input: u64, output: u64) -> UsageAxisCounts {
    UsageAxisCounts {
        input: Some(input),
        output: Some(output),
        ..UsageAxisCounts::default()
    }
}

// Killed by a stop that does not reach the review's run apart from the session's process: the
// review would go on to open its worktree and fail instead of ending interrupted.
#[tokio::test(start_paused = true)]
async fn a_stop_ends_the_staged_review_apart_from_the_session_process() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    parts.run_start.handshakes.observe_handshake_declaration(
        session_id,
        &live.provider_session_id,
        ClaudeHandshakeDeclaration {
            skills: vec!["code-review".to_owned()],
            ..ClaudeHandshakeDeclaration::default()
        },
    );

    fixture
        .driver
        .start_review(StartReviewParams {
            session_id,
            target: SessionReviewTarget::Staged,
        })
        .await
        .expect("the review starts");
    let run_id = daemon_turn_run(&fixture).expect("the review's run was started");
    fixture
        .driver
        .interrupt_run(InterruptRunRequest {
            run_id,
            reason: None,
        })
        .await
        .expect("the stop reaches the review");
    settle().await;

    assert_eq!(fixture.starts.take_one_turns(), []);
    assert!(matches!(
        fixture.engine.moves_of_run(run_id).as_slice(),
        [RunStateEntry::Interrupted { .. }]
    ));
}

// Killed by running a side question in the session's own posture instead of plan mode, on the
// alias instead of its full id, by refusing one on a session at rest, and by metering the copy's
// whole figure, which counts the copied conversation again.
#[tokio::test(start_paused = true)]
async fn a_side_question_runs_in_plan_mode_live_or_at_rest_and_meters_only_its_own_turn() {
    let fixture = ScriptedDriver::new();
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: "opus".to_owned(),
                resolved_model: Some(FULL_MODEL_ID.to_owned()),
                display_name: None,
            }],
            ..ClaudeInitializeDeclaration::default()
        });
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    let live_session = new_session_id();
    fixture
        .driver
        .create_session(CreateSessionParams {
            execution_posture: Some(compose_execution_posture(
                PermissionLevel::Yolo,
                FilesystemPath::new("/".to_owned()).expect("the root is a path"),
            )),
            ..create_params(live_session)
        })
        .await
        .expect("the session opens");
    let resting_session = new_session_id();
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "resolvedModel": FULL_MODEL_ID},
    ]}));
    fixture.usage.report_prior(counts(100, 10));
    fixture.starts.script_one_turn(one_turn_reply("live", None));
    fixture
        .starts
        .script_one_turn(one_turn_reply("at rest", Some(counts(150, 30))));
    let ask = |session_id, resume| AskSideQuestionParams {
        session_id,
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "Why?".to_owned(),
        resume,
    };

    fixture
        .driver
        .ask_side_question(ask(live_session, None))
        .expect("the live session's question is asked");
    ScriptedDriver::wait_for(|| answered(&fixture) == 1).await;
    fixture
        .driver
        .ask_side_question(ask(resting_session, Some(resume_params(resting_session))))
        .expect("the resting session's question is asked");
    ScriptedDriver::wait_for(|| answered(&fixture) == 2).await;

    let live_provider_session = fixture
        .driver
        .composed_parts()
        .expect("composed")
        .slots()
        .live_session(live_session)
        .expect("the session is live")
        .provider_session_id
        .clone();
    let in_plan_mode = |resume_handle: String| ScriptedOneTurnRecord {
        model: FULL_MODEL_ID.to_owned(),
        resume_handle: Some(resume_handle),
        permission_mode: Some(ClaudePermissionMode::Plan),
    };
    assert_eq!(
        fixture.starts.take_one_turns(),
        [
            in_plan_mode(live_provider_session),
            in_plan_mode(resume_params(resting_session).resume_handle),
        ]
    );
    let metered: Vec<_> = fixture
        .usage
        .metered()
        .into_iter()
        .map(|(session_id, delta)| {
            (
                session_id,
                delta.axis_deltas.input,
                delta.axis_deltas.output,
            )
        })
        .collect();
    assert_eq!(metered, [(resting_session, Some(50), Some(20))]);
}

// The side questions answered so far.
fn answered(fixture: &ScriptedDriver) -> usize {
    fixture
        .engine
        .deliveries()
        .iter()
        .filter(|delivery| delivery.kind == "sessionEvent")
        .count()
}

// The run of the first turn the daemon or Claude Code started on a session itself.
fn daemon_turn_run(fixture: &ScriptedDriver) -> Option<RunId> {
    fixture
        .engine
        .calls()
        .into_iter()
        .find_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(_)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
            | EngineCall::EndTurnOnProcessExit(_)
            | EngineCall::EndTurnOnClose(_) => None,
        })
}

// The run ends the driver reported for `run_id`, in order.
fn run_ends(fixture: &ScriptedDriver, run_id: RunId) -> Vec<RunStateEntry> {
    fixture
        .engine
        .moves_of_run(run_id)
        .into_iter()
        .filter(|entry| {
            matches!(
                entry,
                RunStateEntry::Completed { .. }
                    | RunStateEntry::Interrupted { .. }
                    | RunStateEntry::Stopped { .. }
                    | RunStateEntry::Failed { .. }
            )
        })
        .collect()
}

// A run started through the driver interface, on a driver composed from the run engine and
// inbound dispatch its ports hold, ends `completed` on the process result.
#[tokio::test(start_paused = true)]
async fn a_run_started_through_the_driver_trait_ends_on_the_process_result() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let run_id = new_run_id();
    let claude = Arc::new(ClaudeDriver::with_starts(
        &fixture.services,
        fixture.starts.clone(),
    ));
    let driver: Arc<dyn ProviderDriver> = claude.clone();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    driver
        .create_session(create_params(session_id))
        .await
        .expect("the session opens");
    let start = fixture.next_start().await;

    driver
        .start_run(start_params(session_id, run_id))
        .await
        .expect("the run starts");
    end_turn_of(&claude, &start, session_id);
    ScriptedDriver::wait_for(|| !run_ends(&fixture, run_id).is_empty()).await;

    assert!(matches!(
        run_ends(&fixture, run_id).as_slice(),
        [RunStateEntry::Completed { .. }]
    ));
    assert_eq!(channel.user_frames().len(), 1);
}

// Killed by a close that leaves the run in flight with no end, by ending it through anything but
// the run engine's close, which marks it the daemon's intended close, and by a second end of a
// run the close already ended.
#[tokio::test(start_paused = true)]
async fn a_close_ends_the_run_in_flight_through_the_engines_close() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let run_id = new_run_id();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    driver
        .create_session(create_params(session_id))
        .await
        .expect("the session opens");
    fixture.next_start().await;
    driver
        .start_run(start_params(session_id, run_id))
        .await
        .expect("the run starts");

    driver
        .close_session(CloseSessionParams { session_id })
        .await
        .expect("the session closes");
    settle().await;

    assert_eq!(
        fixture.engine.turn_ends(),
        [EngineCall::EndTurnOnClose(run_id)]
    );
    assert_eq!(run_ends(&fixture, run_id), []);
}

// Killed by a close that stops taking its process's frames once the channel closes (the wait on
// the session's task deleted from `close_channel`): the reply and the `result` queued behind a held
// delivery would be dropped and the run would end through the close, not on its `result`; by a
// closing slot that refuses every frame; and by a `result` read after the close began that is not
// marked the daemon's intended close.
#[tokio::test(start_paused = true)]
async fn the_frames_read_before_the_close_ended_the_process_end_their_run_as_intended() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let run_id = new_run_id();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    driver
        .create_session(create_params(session_id))
        .await
        .expect("the session opens");
    let start = fixture.next_start().await;
    driver
        .start_run(start_params(session_id, run_id))
        .await
        .expect("the run starts");
    let release_engine = fixture.engine.hold_next_delivery();
    let release_close = channel.hold_next_close();

    let close = tokio::spawn({
        let driver = Arc::clone(&driver);
        async move {
            driver
                .close_session(CloseSessionParams { session_id })
                .await
        }
    });
    settle().await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let routes = &parts.run_start.routes;
    for frame in [
        json!({"type": "system", "subtype": "init", "session_id": SCRIPTED_PROVIDER_SESSION_ID}),
        json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [{"type": "text", "text": "the reply"}],
            },
        }),
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "the reply",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }),
    ] {
        hand_scripted_frame(&*start.listener, routes, session_id, &frame);
    }
    settle().await;
    drop(release_close);
    settle().await;
    assert!(
        !close.is_finished(),
        "the close waits for the session's task"
    );
    drop(release_engine);
    close
        .await
        .expect("the close task ends")
        .expect("the session closes");
    settle().await;

    assert_eq!(
        run_ends(&fixture, run_id),
        [RunStateEntry::Completed {
            intended_close: Some(BoolLiteral)
        }]
    );
    let replies = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| matches!(delivery.row, Some(LateAppendableRow::AgentMessageSent(_))))
        .count();
    assert_eq!(replies, 1);
}

// Killed by reading the close's run list before its channel closes (the `bound_runs_on` read in
// `close_session` moved back before `close_channel()`): a turn Claude Code started by itself while
// the close drained the session's task would be left running once its process exited.
#[tokio::test(start_paused = true)]
async fn a_turn_claude_code_started_while_the_close_drained_ends_as_intended() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    driver
        .create_session(create_params(session_id))
        .await
        .expect("the session opens");
    let start = fixture.next_start().await;
    let release_start = fixture.engine.hold_next_daemon_turn_start();
    let parts = fixture.driver.composed_parts().expect("composed");
    let routes = &parts.run_start.routes;
    hand_scripted_frame(
        &*start.listener,
        routes,
        session_id,
        &json!({"type": "system", "subtype": "init", "session_id": SCRIPTED_PROVIDER_SESSION_ID}),
    );
    settle().await;

    let close = tokio::spawn({
        let driver = Arc::clone(&driver);
        async move {
            driver
                .close_session(CloseSessionParams { session_id })
                .await
        }
    });
    settle().await;
    drop(release_start);
    close
        .await
        .expect("the close task ends")
        .expect("the session closes");
    settle().await;

    let self_started = daemon_turn_run(&fixture).expect("the self-started turn's run opened");
    assert_eq!(
        fixture.engine.turn_ends(),
        [EngineCall::EndTurnOnClose(self_started)]
    );
}
