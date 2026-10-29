//! The session controls that run beside a session's own turns, reached through the driver: a side
//! question, a review, a mode move, a run started through the driver interface and a fork.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::BoolLiteral;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_std::mutex_lock::lock;

use super::{resume_params, start_params};
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::{
    ScriptedDriver, create_params, end_turn_of,
};
use crate::driver::claude::session::scripted::starts::ScriptedOneTurnRecord;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, binding_id, hand_scripted_frame, settle,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::declarations::{
    ClaudeCumulativeUsageObservation, ClaudeHandshakeDeclaration, ClaudeInitializeDeclaration,
    ClaudeOfferedModel,
};
use crate::driver::claude::spawn::launch::one_turn::ClaudeOneTurnReply;
use crate::driver::contract::{DriverError, ProviderDriver, RunOpeningItem};
use crate::driver::run_control::InterruptRunRequest;
use crate::driver::session_control::{
    AskSideQuestionParams, CloseSessionParams, CreateSessionParams, MoveSessionToForkParams,
    UpdateSessionModeParams,
};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::EngineCall;
use crate::port::running_command_publisher::RunningCommandParams;
use crate::run::delivery::LateAppendableRow;
use crate::run::posture::compose_execution_posture;
use crate::run::state_entry::RunStateEntry;
use crate::usage_delta_accountant::UsageAxisCounts;

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

// Lets the session's process run Claude Code's `code-review` skill.
fn offer_review_skill(fixture: &ScriptedDriver, session_id: SessionId) {
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
}

// Killed by a stop that does not reach the review's run apart from the session's process: the
// review would go on to open its worktree and fail instead of ending interrupted.
#[tokio::test(start_paused = true)]
async fn a_stop_ends_the_staged_review_apart_from_the_session_process() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    offer_review_skill(&fixture, session_id);

    let run_id = new_run_id();
    let mut params = start_params(session_id, run_id);
    params.opening.item = RunOpeningItem::Review {
        target: SessionReviewTarget::Staged,
    };
    fixture
        .driver
        .start_run(params)
        .await
        .expect("the review starts");
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

// Killed by opening a queued review's run with the message path, which writes no review command,
// by starting the review under a run of the daemon's own instead of the queue's, by naming the
// wrong changes, and by dropping its start notice.
#[rstest]
#[case::branch(SessionReviewTarget::Branch, "/code-review")]
#[case::working_tree(
    SessionReviewTarget::WorkingTree,
    "/code-review the uncommitted changes in the working tree"
)]
#[tokio::test(start_paused = true)]
async fn a_queued_review_runs_claude_codes_review_as_the_queues_run(
    #[case] target: SessionReviewTarget,
    #[case] command: &str,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    offer_review_skill(&fixture, session_id);
    let run_id = new_run_id();
    let mut params = start_params(session_id, run_id);
    params.opening.item = RunOpeningItem::Review { target };
    let message_id = params.opening.message_id;

    fixture
        .driver
        .start_run(params)
        .await
        .expect("the review starts");

    let written = channel.user_frames();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["message"]["content"], command);
    assert_eq!(written[0]["uuid"], message_id.to_string());
    assert_eq!(fixture.engine.first_daemon_turn_run(), None);
    let parts = fixture.driver.composed_parts().expect("composed");
    assert_eq!(
        parts
            .run_start
            .routes
            .lead_run_on(session_id)
            .map(|lead| lead.run_id),
        Some(run_id)
    );
    let review_starts: Vec<_> = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionNotice")
        .filter_map(|delivery| delivery.payload)
        .filter(|notice| notice["kind"] == "reviewStarted")
        .collect();
    assert_eq!(review_starts.len(), 1);
}

// Killed by answering Claude Code's refusal of a mode as an internal failure.
#[tokio::test(start_paused = true)]
async fn a_mode_claude_code_refuses_is_refused_as_not_offered() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    channel.answer("set_permission_mode", ScriptedAnswer::Refused);

    let moved = fixture
        .driver
        .update_session_mode(UpdateSessionModeParams {
            session_id,
            mode: SessionMode::Plan,
        })
        .await;

    let Err(DriverError::Refused(refusal)) = moved else {
        panic!("a refused mode is refused, not {moved:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionModeNotOffered);
}

// Killed by a staged review whose process starts with no channel of its own, and by one that keeps
// the session process's channel variables, which admit no party under the review's process.
#[tokio::test]
async fn the_staged_reviews_process_starts_on_a_channel_of_its_own() {
    if !RUNS_COMMAND_WRAPPER {
        return;
    }
    let fixture = ScriptedDriver::new();
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let session_channel = live
        .spawn_bound_legs
        .command_channel
        .clone()
        .expect("the session's process has a channel");

    let (legs, review_channel) = parts
        .session_controls
        .compose_review_legs(&live, new_run_id(), fixture.work.clone())
        .await
        .expect("the review's legs compose");

    let review_channel = review_channel.expect("the review has a channel of its own");
    let review_variables = review_channel.environment();
    assert!(
        review_variables
            .iter()
            .all(|variable| legs.spawn_environment.contains(variable))
    );
    assert!(
        session_channel
            .environment()
            .iter()
            .filter(|variable| !review_variables.contains(variable))
            .all(|variable| !legs.spawn_environment.contains(variable))
    );
    assert!(
        legs.spawn_environment
            .contains(&("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()))
    );
    review_channel
        .close()
        .await
        .expect("the review's channel is removed");
}

// Killed by a stop or a move of a staged review's command sent to the session's own process,
// which holds no such task, and by a stop that leaves the review's turn untold.
#[tokio::test]
async fn a_staged_reviews_command_is_stopped_and_moved_on_the_reviews_own_process() {
    if !RUNS_COMMAND_WRAPPER {
        return;
    }
    let fixture = ScriptedDriver::new();
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_process = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&session_process).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let (_legs, review_channel) = parts
        .session_controls
        .compose_review_legs(&live, new_run_id(), fixture.work.clone())
        .await
        .expect("the review's legs compose");
    let review_channel = review_channel.expect("the review has a channel of its own");
    let review = review_channel.apart_run().expect("the review's commands");
    let review_process = Arc::new(ScriptedChannel::default());
    review.serve(Arc::clone(&review_process) as Arc<dyn ClaudeProcessChannel>);
    review.read_frame(
        "assistant",
        &json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": "sleep 60"}},
        ]}})
        .to_string(),
    );
    for task_id in ["task-1", "task-2"] {
        review.read_frame(
            "system/task_started",
            &json!({"type": "system", "subtype": "task_started", "task_id": task_id,
                "task_type": "local_bash", "tool_use_id": "call-1"})
            .to_string(),
        );
    }
    let command = |task_id: &str| RunningCommandParams {
        session_id,
        binding_id: binding_id("lead"),
        command_id: CommandId::new(task_id.to_owned()).expect("a command id"),
    };

    let moved = parts
        .run_controls
        .move_command_to_background(&command("task-1"))
        .await
        .expect("the move is answered");
    parts
        .run_controls
        .stop_command(&command("task-1"))
        .await
        .expect("the review's process acknowledges the stop");

    assert!(moved);
    assert!(!session_process.control_requests().iter().any(|request| {
        ["background_tasks", "stop_task"].contains(&request["subtype"].as_str().unwrap_or_default())
    }));
    let requests = review_process.control_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["subtype"], "background_tasks");
    assert_eq!(requests[0]["tool_use_id"], "call-1");
    assert_eq!(requests[1]["subtype"], "stop_task");
    assert_eq!(requests[1]["task_id"], "task-1");
    let told = review_process.user_frames();
    assert_eq!(told.len(), 1);
    assert!(told[0].to_string().contains("The user stopped `sleep 60`."));
    review.end();
    review_channel
        .close()
        .await
        .expect("the review's channel is removed");
}

// Killed by running a side question in the session's own posture instead of plan mode, on the
// alias instead of its full id, by refusing one on a session at rest, by metering the copy's turn
// from the session's reported base instead of from zero (a `result`'s usage is its own turn's), and
// by a copy that keeps an askpass or channel variable or sets only `GIT_TERMINAL_PROMPT` of the
// no-prompt environment.
#[tokio::test(start_paused = true)]
async fn a_side_question_runs_in_plan_mode_live_or_at_rest_and_meters_only_its_own_turn() {
    let fixture = ScriptedDriver::new();
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
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
        binding_id: binding_id("lead"),
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "Why?".to_owned(),
        resume,
    };

    fixture
        .driver
        .ask_side_question(ask(live_session, None))
        .await
        .expect("the live session's question is answered");
    assert_eq!(answered(&fixture), 1);
    fixture
        .driver
        .ask_side_question(ask(resting_session, Some(resume_params(resting_session))))
        .await
        .expect("the resting session's question is answered");
    assert_eq!(answered(&fixture), 2);

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
    let prompt_variables = |environment: &[(String, String)]| -> Vec<(String, String)> {
        let mut variables: Vec<_> = environment
            .iter()
            .filter(|(name, _)| {
                name.contains("ASKPASS")
                    || name.starts_with("SIDEKICKS_COMMAND")
                    || [
                        "GCM_INTERACTIVE",
                        "GIT_TERMINAL_PROMPT",
                        "CLAUDE_CODE_SHELL_PREFIX",
                    ]
                    .contains(&name.as_str())
            })
            .cloned()
            .collect();
        variables.sort();
        variables
    };
    let no_prompt: Vec<_> = [
        ("GCM_INTERACTIVE", "never"),
        ("GIT_ASKPASS", ""),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("SSH_ASKPASS_REQUIRE", "never"),
    ]
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .into();
    let environments = fixture.starts.take_one_turn_environments();
    assert_eq!(environments.len(), 2);
    for environment in &environments {
        assert_eq!(prompt_variables(environment), no_prompt);
    }
    let metered: Vec<_> = fixture
        .usage
        .metered()
        .into_iter()
        .map(|metered| {
            (
                metered.session_id,
                metered.delta.axis_deltas.input,
                metered.delta.axis_deltas.output,
            )
        })
        .collect();
    assert_eq!(metered, [(resting_session, Some(150), Some(30))]);
}

// Killed by answering a side question the model refused as an internal failure.
#[tokio::test(start_paused = true)]
async fn a_side_question_the_model_refuses_is_refused_as_such() {
    let fixture = ScriptedDriver::new();
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "resolvedModel": FULL_MODEL_ID},
    ]}));
    fixture.starts.script_one_turn(ClaudeOneTurnReply {
        refusal: Some(RunFailureCause::Refused {
            origin: RunRefusedOrigin::Provider,
            model: FreeFormText::new(FULL_MODEL_ID.to_owned()).expect("a model id is text"),
            sentence: None,
            explanation: None,
            safety_category: None,
        }),
        ..one_turn_reply("", None)
    });
    let session_id = new_session_id();

    let asked = fixture
        .driver
        .ask_side_question(AskSideQuestionParams {
            session_id,
            binding_id: binding_id("lead"),
            side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
            question: "Why?".to_owned(),
            resume: Some(resume_params(session_id)),
        })
        .await;

    let Err(DriverError::Refused(refusal)) = asked else {
        panic!("a refused side question is refused, not {asked:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionSideQuestionRefused);
    assert_eq!(answered(&fixture), 0);
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
        fixture.starts.keychain.clone(),
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

    let self_started = fixture
        .engine
        .first_daemon_turn_run()
        .expect("the self-started turn's run opened");
    assert_eq!(
        fixture.engine.turn_ends(),
        [EngineCall::EndTurnOnClose(self_started)]
    );
}

// Killed by bringing the fork up on the step bound its predecessor started with rather than the
// one the session holds at the fork: a limit changed after the predecessor started would never
// reach the conversation that replaces it.
#[tokio::test(start_paused = true)]
async fn a_fork_starts_on_the_step_bound_the_session_holds_at_its_bring_up() {
    let fixture = ScriptedDriver::new();
    *lock(&fixture.step_bound) = SafeInt::new(3);
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let conversation = fixture
        .driver
        .composed_parts()
        .expect("composed")
        .slots()
        .live_session(session_id)
        .expect("the session is live")
        .provider_session_id
        .clone();
    // Two turns, so a fork after the first has a later turn to discard.
    let project_folder = fixture.home.join(".claude/projects/work");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    std::fs::write(
        project_folder.join(format!("{conversation}.jsonl")),
        concat!(
            r#"{"type":"user","uuid":"u1","message":{"content":"first"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","message":{"content":"one"}}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","message":{"content":"second"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a2","message":{"content":"two"}}"#,
            "\n",
        ),
    )
    .expect("the conversation is written");
    *lock(&fixture.step_bound) = SafeInt::new(7);
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    fixture
        .driver
        .move_session_to_fork(MoveSessionToForkParams {
            session_id,
            position: SafeInt::new(1).expect("1 is a position"),
            binding_id: binding_id("lead"),
        })
        .await
        .expect("the fork is answered");

    let bounds: Vec<_> = fixture
        .starts
        .take_started()
        .iter()
        .map(|start| start.step_bound)
        .collect();
    assert_eq!(bounds, [Some(3), Some(7)]);
}
