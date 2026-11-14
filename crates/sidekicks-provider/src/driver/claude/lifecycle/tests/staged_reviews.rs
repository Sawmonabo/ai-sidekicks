//! A staged review reached through the driver: Claude Code's review run as the queue's run, apart
//! from the session's process, in its level's own mode and on a channel of its own, its command
//! stopped and moved on that process.

use std::pin::pin;
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::process::test_repository::make_test_repository;
use tokio_util::sync::CancellationToken;

use super::session_controls::{one_turn_outcome, one_turn_reply, opus_spend};
use super::start_params;
use crate::bounded_poll::poll_until;
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::{binding_id, register_claude_price_list, settle};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnOutcome, ClaudeOneTurnReply};
use crate::driver::contract::params_and_results::RunOpeningItem;
use crate::driver::run_control::InterruptRunRequest;
use crate::driver::test_registry::new_run_id;
use crate::port::running_command_publisher::{
    CommandStopCause, RunningCommandParams, StopCommandParams,
};
use crate::port::usage_sink::MeteredUsageOwner;
use crate::run::state_entry::RunStateEntry;
use crate::runtime_binding::test_store::test_provider_account_id;

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

// Killed by a staged review whose one-turn process asks for a mode of its own, Plan or any
// other, in place of its level's.
#[tokio::test]
async fn a_staged_reviews_process_runs_in_its_levels_own_mode() {
    let fixture = ScriptedDriver::new();
    let git = test_git_runner();
    // The review's worktree is made from the session's working folder, so it is a repository.
    make_test_repository(&git, fixture.folder.path(), "work").await;
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    offer_review_skill(&fixture, session_id);
    let reported = ClaudeOneTurnReply {
        provider_message_id: Some("review".to_owned()),
        ..one_turn_reply("Nothing to change.")
    };
    fixture
        .starts
        .script_one_turn(one_turn_outcome(reported, None));
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
    poll_until(
        || fixture.engine.moves_of_run(run_id),
        |moves| {
            moves.iter().any(|entry| {
                matches!(
                    entry,
                    RunStateEntry::Completed { .. } | RunStateEntry::Failed { .. }
                )
            })
        },
    )
    .await;

    let modes: Vec<_> = fixture
        .starts
        .take_one_turns()
        .into_iter()
        .map(|one_turn| one_turn.permission_mode)
        .collect();
    assert_eq!(modes, [None]);
}

// Killed by recording only a review that reported, by recording its spend after its run's end,
// and by owning its rows as the session's copy rather than its run's: a refused review keeps its
// result's figure and a stopped one is priced from the list, each on the review's own binding.
#[rstest]
#[case::refused(true, UsageCostSource::ProviderReported)]
#[case::stopped(false, UsageCostSource::DerivedExact)]
#[tokio::test]
async fn a_staged_reviews_spend_is_recorded_on_its_run_however_it_ends(
    #[case] is_refused: bool,
    #[case] cost_source: UsageCostSource,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let fixture = ScriptedDriver::new();
    register_claude_price_list(&fixture.services.ports.price_list, &scratch, &stop).await;
    make_test_repository(&test_git_runner(), fixture.folder.path(), "work").await;
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    offer_review_skill(&fixture, session_id);
    let outcome = if is_refused {
        let refused = ClaudeOneTurnReply {
            refusal: Some(RunFailureCause::Refused {
                origin: RunRefusedOrigin::Provider,
                model: FreeFormText::new("claude-opus-5-5".to_owned()).expect("a model id"),
                sentence: None,
                explanation: None,
                safety_category: None,
            }),
            ..one_turn_reply("")
        };
        let spend = opus_spend(&[(1_000, 500)], Some((1_000, 500, 0.014)));
        one_turn_outcome(refused, Some(spend))
    } else {
        ClaudeOneTurnOutcome {
            reply: Err(ClaudeLaunchError::TurnStopped),
            spend: Some(opus_spend(&[(1_000, 500)], None)),
        }
    };
    fixture.starts.script_one_turn(outcome);
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
    poll_until(
        || fixture.engine.moves_of_run(run_id),
        |moves| (moves.iter()).any(|entry| matches!(entry, RunStateEntry::Failed { .. })),
    )
    .await;
    stop.cancel();

    let metered: Vec<_> = fixture
        .usage
        .metered()
        .into_iter()
        .map(|metered| (metered.owner, metered.binding_id))
        .collect();
    assert_eq!(metered, [(MeteredUsageOwner::Run, binding_id("lead"))]);
    let account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        fixture.usage.priced_shares(),
        [(cost_source, vec![(account, 14_000)])]
    );
}

// Killed by the review's turn recorded on the review's own task, which nothing waits for: the
// daemon's stop would end the runtime under the turn and its spend row would be lost.
#[tokio::test]
async fn the_stop_waits_out_a_staged_review_mid_turn_and_its_spend_is_recorded() {
    let fixture = ScriptedDriver::new();
    make_test_repository(&test_git_runner(), fixture.folder.path(), "work").await;
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    offer_review_skill(&fixture, session_id);
    let reported = ClaudeOneTurnReply {
        provider_message_id: Some("review".to_owned()),
        ..one_turn_reply("Nothing to change.")
    };
    let release = fixture
        .starts
        .script_one_turn_until_released(one_turn_outcome(
            reported,
            Some(opus_spend(&[(1_000, 500)], None)),
        ));
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
    poll_until(
        || fixture.starts.take_one_turns(),
        |turns| !turns.is_empty(),
    )
    .await;

    let parts = fixture.driver.composed_parts().expect("composed");
    let mut stop_waits = pin!(parts.session_controls.wait_for_recorded_turns());
    assert!(
        futures::poll!(stop_waits.as_mut()).is_pending(),
        "the stop waits for the review's turn"
    );
    release.send(()).expect("the turn waits for its release");
    stop_waits.await;

    let metered: Vec<_> = (fixture.usage.metered().into_iter())
        .map(|metered| (metered.owner, metered.delta.axis_deltas.input))
        .collect();
    assert_eq!(metered, [(MeteredUsageOwner::Run, Some(1_000))]);
}

// A staged review's run, on a binding of its own.
fn review_run() -> ClaudeBoundRun {
    ClaudeBoundRun {
        run_id: new_run_id(),
        binding_id: binding_id("review"),
    }
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
        .compose_review_legs(&live, review_run(), fixture.work.clone())
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
        .compose_review_legs(&live, review_run(), fixture.work.clone())
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
        .stop_command(&StopCommandParams {
            command: command("task-1"),
            cause: CommandStopCause::Person,
        })
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
