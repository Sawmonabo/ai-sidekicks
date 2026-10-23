//! The session controls that run beside a session's own turns, reached through the driver: a side
//! question, the staged review and a run started through the driver interface.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;

use super::{DriverFixture, create_params, end_turn_of, resume_params, start_params};
use crate::events::log_service::tests::open_log;
use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::lifecycle::ClaudeDriver;
use crate::provider::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::provider::driver::claude::session::scripted::run_engine::EngineCall;
use crate::provider::driver::claude::session::scripted::starts::ScriptedOneTurnRecord;
use crate::provider::driver::claude::session::scripted::{
    binding_id, mint_run_id, mint_session_id, settle,
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
    AskSideQuestionParams, CreateSessionParams, StartReviewParams,
};
use crate::provider::usage_delta_accountant::UsageAxisCounts;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::epochs::{EpochBinding, ExecutionEpochs};
use crate::session::run::inbound::RunInboundDispatch;
use crate::session::run::inbound::tests::UnreadPublisher;
use crate::session::run::state_change::RunStateEntry;

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
    let fixture = DriverFixture::new();
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
    let run_id = fixture
        .engine
        .calls()
        .into_iter()
        .find_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(_)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
            | EngineCall::EndTurnOnProcessExit(_) => None,
        })
        .expect("the review's run was started");
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
    let ends: Vec<_> = fixture
        .engine
        .run_moves()
        .into_iter()
        .filter_map(|delivery| delivery.change)
        .filter(|change| change.run_id == run_id)
        .map(|change| change.entry)
        .collect();
    assert!(matches!(
        ends.as_slice(),
        [RunStateEntry::Interrupted { .. }]
    ));
}

// Killed by running a side question in the session's own posture instead of plan mode, on the
// alias instead of its full id, by refusing one on a session at rest, and by metering the copy's
// whole figure, which counts the copied conversation again.
#[tokio::test(start_paused = true)]
async fn a_side_question_runs_in_plan_mode_live_or_at_rest_and_meters_only_its_own_turn() {
    let fixture = DriverFixture::new();
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
    let live_session = mint_session_id();
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
    let resting_session = mint_session_id();
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
    DriverFixture::wait_for(|| answered(&fixture) == 1).await;
    fixture
        .driver
        .ask_side_question(ask(resting_session, Some(resume_params(resting_session))))
        .expect("the resting session's question is asked");
    DriverFixture::wait_for(|| answered(&fixture) == 2).await;

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
fn answered(fixture: &DriverFixture) -> usize {
    fixture
        .engine
        .deliveries()
        .iter()
        .filter(|delivery| delivery.kind == "sessionEvent")
        .count()
}

// A run started through the driver interface, on the daemon's own run engine and inbound
// dispatch as the driver reaches them through its ports, ends `completed` on the process result.
#[tokio::test(start_paused = true)]
async fn a_run_started_through_the_driver_trait_ends_on_the_process_result() {
    let fixture = DriverFixture::new();
    let session_id = mint_session_id();
    let run_id = mint_run_id();
    insert_running_run(&fixture.database, session_id, run_id);
    let mut epochs = ExecutionEpochs::new(NonZeroUsize::new(2).expect("the cap is not zero"));
    epochs
        .open_binding(
            EpochBinding {
                id: binding_id("lead"),
                run_id,
                provider_name: DESCRIPTOR.provider_id(),
                provider_account_id: None,
            },
            RUN_START_POSITION,
        )
        .expect("the binding has no cursor yet");
    let log = open_log(&fixture.database, None).await;
    let engine = test_engine(&fixture.database, Arc::clone(&log.service), &fixture.home);
    let ports = &fixture.services.ports;
    ports
        .inbound_dispatch
        .register(Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            Arc::new(Mutex::new(epochs)),
            Arc::new(UnreadPublisher),
            log.service,
        )))
        .expect("the dispatch registers once");
    ports
        .run_engine
        .register(engine)
        .expect("the run engine registers once");
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
    DriverFixture::wait_for(|| stored_run_state(&fixture.database, &run_id).0 == "completed").await;

    assert_eq!(channel.user_frames().len(), 1);
}
