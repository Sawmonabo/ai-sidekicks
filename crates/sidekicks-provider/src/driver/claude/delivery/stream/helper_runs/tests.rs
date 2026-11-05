use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::{RunFailureCategory, StopTrigger};
use sidekicks_contracts::run::id::RunId;
use sidekicks_std::mutex_lock::lock;

use super::super::tests::result;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudePauseAnswer};
use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::run_control::HelperStopReason;
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::{LateAppendableRow, RunSetupRefusal};
use crate::run::state_entry::RunStateEntry;

/// A helper's `task_started`, launched by the helper `parent` where one is named, started as
/// `role` where one is named.
pub(in super::super) fn nested_start(
    task_id: &str,
    call_id: &str,
    parent: Option<&str>,
    role: Option<&str>,
) -> Value {
    let mut frame = helper_started(task_id, "local_agent", call_id);
    if let Some(parent) = parent {
        frame["parent_task_id"] = json!(parent);
    }
    if let Some(role) = role {
        frame["subagent_type"] = json!(role);
    }
    frame
}

/// One child run delivery as a test reads it.
#[derive(Debug, PartialEq)]
pub(in super::super) struct ChildRunRead {
    /// The helper's agent id.
    pub(in super::super) helper: String,
    /// The run it starts beneath.
    pub(in super::super) parent_run_id: Option<RunId>,
    /// The helper that launched it.
    pub(in super::super) launcher: Option<String>,
    /// What it was started as.
    pub(in super::super) role: Option<String>,
    /// The call that started it.
    pub(in super::super) start_call: Option<String>,
}

/// Each child run delivery, in order.
pub(in super::super) fn child_runs(deliveries: &[RecordedDelivery]) -> Vec<ChildRunRead> {
    deliveries
        .iter()
        .filter(|delivery| delivery.kind == "childRun")
        .map(|delivery| {
            let subagent = delivery
                .subagent
                .clone()
                .expect("a child run delivery names its helper");
            ChildRunRead {
                helper: subagent.subagent_id.as_str().to_owned(),
                parent_run_id: delivery.parent_run_id,
                launcher: subagent
                    .parent_subagent_id
                    .map(|parent| parent.as_str().to_owned()),
                role: subagent.role.map(|role| role.as_str().to_owned()),
                start_call: subagent.start_call_id.map(|call| call.as_str().to_owned()),
            }
        })
        .collect()
}

/// Each lifecycle row of the helper `agent_id` as (is a start, the run it sits on, its child
/// run).
pub(in super::super) fn lifecycle_rows(
    deliveries: &[RecordedDelivery],
    agent_id: &str,
) -> Vec<(bool, RunId, Option<RunId>)> {
    deliveries
        .iter()
        .filter_map(|delivery| {
            if let Some(LateAppendableRow::AgentSubagentStarted(payload)) = &delivery.row {
                Some((true, payload))
            } else if let Some(LateAppendableRow::AgentSubagentCompleted(payload)) = &delivery.row {
                Some((false, payload))
            } else {
                None
            }
        })
        .filter(|(_, payload)| payload.subagent_id.as_str() == agent_id)
        .map(|(is_start, payload)| (is_start, payload.run_id, payload.child_run_id))
        .collect()
}

// A nested helper hangs under its launcher's run, a helper whose launcher no route knows under
// the lead with that launcher's id kept, and both of the nested helper's rows sit on its
// start's run. Killed by every start hanging under the lead, by dropping the launcher's id, by
// taking the router's filtered parent (the unknown launcher's id reads as none), by dropping
// the role, by leaving the nested helper's start or end row on the lead (the end tried on the
// turn's lead first), and by an unknown launcher not falling back to the lead.
#[tokio::test(start_paused = true)]
async fn a_nested_helper_hangs_under_its_launchers_run_and_an_unknown_one_under_the_lead() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&nested_start("p", "call-p", None, Some("Explore")));
    session.frame(&nested_start("c", "call-c", Some("p"), Some("Plan")));
    session.frame(&nested_start("g", "call-g", Some("ghost"), None));
    settle().await;
    let routes = &session.start.routes;
    let parent_run = routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    let nested_run = routes
        .child_run_for(session.session_id, "c")
        .expect("the nested helper has its child run");
    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "c",
        "tool_use_id": "call-c",
        "status": "completed",
        "summary": "Planned",
    }));
    settle().await;

    let deliveries = session.engine.deliveries();
    assert_eq!(
        child_runs(&deliveries),
        [
            ChildRunRead {
                helper: "p".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: None,
                role: Some("Explore".to_owned()),
                start_call: Some("call-p".to_owned()),
            },
            ChildRunRead {
                helper: "c".to_owned(),
                parent_run_id: Some(parent_run),
                launcher: Some("p".to_owned()),
                role: Some("Plan".to_owned()),
                start_call: Some("call-c".to_owned()),
            },
            ChildRunRead {
                helper: "g".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: Some("ghost".to_owned()),
                role: None,
                start_call: Some("call-g".to_owned()),
            },
        ]
    );
    assert_eq!(
        lifecycle_rows(&deliveries, "c"),
        [
            (true, parent_run, Some(nested_run)),
            (false, parent_run, Some(nested_run)),
        ]
    );
}

// A helper launched by one whose run the daemon refused hangs under the lead, the refused
// launcher's id kept, so it gets a run of its own. Killed by the refused launcher's ended run
// carrying the start (it hangs under that run).
#[tokio::test(start_paused = true)]
async fn a_helper_launched_by_a_refused_one_hangs_under_the_lead() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.engine.refuse_next_child_run(earlier_refusal());
    session.frame(&nested_start("p", "call-p", None, None));
    session.frame(&nested_start("c", "call-c", Some("p"), None));
    settle().await;

    let nested = child_runs(&session.engine.deliveries())
        .into_iter()
        .find(|read| read.helper == "c")
        .expect("the nested helper's start is delivered");
    assert_eq!(nested.parent_run_id, Some(lead_run));
    assert_eq!(nested.launcher.as_deref(), Some("p"));
}

// A background helper that launches a helper after the lead's turn ended still carries it: the
// nested start hangs under the launcher's run on the lead's binding, and opens no turn. Killed
// by dropping the start as unmapped once no lead holds the turn, by opening the turn on the run
// the start hangs under, and by trying the launcher only while a lead holds the turn.
#[tokio::test(start_paused = true)]
async fn a_background_helpers_nested_start_after_the_turn_ended_hangs_under_it() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&helper_started("p", "local_agent", "call-p"));
    settle().await;
    let parent_run = session
        .start
        .routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    session.frame(&result(&json!({})));
    settle().await;
    let before_nested_start = session.engine.deliveries().len();
    session.frame(&nested_start("c2", "call-c2", Some("p"), None));
    settle().await;

    let deliveries = session.engine.deliveries();
    let after_turn = &deliveries[before_nested_start..];
    let nested_child_run = after_turn
        .iter()
        .find(|delivery| delivery.kind == "childRun")
        .expect("the nested start gets its child run");
    assert_eq!(nested_child_run.parent_run_id, Some(parent_run));
    assert_eq!(nested_child_run.binding_id, Some(binding_id("lead")));
    assert!(
        lifecycle_rows(after_turn, "c2")
            .iter()
            .any(|&(is_start, run_id, _)| is_start && run_id == parent_run),
        "the nested start's row sits on its launcher's run"
    );
    assert!(
        after_turn
            .iter()
            .all(|delivery| delivery.kind != "turnBoundary"),
        "a start after the turn ended opens no turn"
    );
}

/// The `task_notification` that ends the helper `task_id` with `status`.
pub(in super::super) fn helper_ended(task_id: &str, status: &str, summary: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": task_id,
        "tool_use_id": "call-1",
        "status": status,
        "summary": summary,
    })
}

// How the daemon answers the helper `agent_id`'s next pre-tool callback.
fn helper_tool_answer(session: &ScriptedSession, agent_id: &str) -> ClaudePauseAnswer {
    lock(&session.parts.run_controls.pauses).answer_before_tool(
        &session.session_id,
        Some(agent_id),
        "helper-tool",
        &mut None,
    )
}

// Whether the helper `agent_id`'s next tool use is denied with words holding `words`.
fn is_denied_with(session: &ScriptedSession, agent_id: &str, words: &str) -> bool {
    matches!(
        helper_tool_answer(session, agent_id),
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny { reason }) if reason.contains(words)
    )
}

// A helper's end reads by why the daemon stopped it: a stop from the console is final, a token
// limit stops it with that trigger even when it finished, and Claude Code's own stop reads as
// an interruption. The end is the daemon's own where the console stopped the helper, its pause
// already dropped, or an interrupt holds it. Killed by reading every `stopped` as final, by
// reading the console's stop as an interruption, by leaving a token-limited finish completed,
// by dropping the trigger, by answering the console's stop with another reason's sentence, by
// marking the end of neither the console's stop nor a held helper as the daemon's, and by
// marking every end so.
#[rstest]
#[case::stop_all(
    Some(HelperStopReason::StopAll),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::StopAll) },
    true
)]
#[case::token_limit_stopped(
    Some(HelperStopReason::TokenLimit),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
#[case::token_limit_completed(
    Some(HelperStopReason::TokenLimit),
    false,
    "completed",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
#[case::held(
    None,
    true,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    true
)]
#[case::own_stop(
    None,
    false,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    false
)]
#[case::own_finish(
    None,
    false,
    "completed",
    RunStateEntry::Completed { intended_close: None },
    false
)]
#[tokio::test(start_paused = true)]
async fn a_helpers_end_reads_by_why_it_was_stopped(
    #[case] stop: Option<HelperStopReason>,
    #[case] is_held: bool,
    #[case] status: &str,
    #[case] expected: RunStateEntry,
    #[case] is_daemon_interrupt_end: bool,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    let child_run = session
        .start
        .routes
        .child_run_for(session.session_id, "helper")
        .expect("the helper has its child run");
    let is_stop_all = stop == Some(HelperStopReason::StopAll);
    if let Some(stop) = stop {
        lock(&session.parts.run_controls.pauses).stop_helper(session.session_id, "helper", stop);
    }
    if is_held {
        lock(&session.parts.run_controls.pauses)
            .hold_interrupted_helper(&session.session_id, "helper");
    }

    session.frame(&helper_ended("helper", status, "Reported"));
    settle().await;

    assert_eq!(session.engine.moves_of_run(child_run), [expected]);
    assert_eq!(
        session.engine.daemon_interrupt_ends_of_run(child_run),
        [is_daemon_interrupt_end]
    );
    if is_stop_all {
        assert!(is_denied_with(&session, "helper", "will not be resumed"));
    }
}

// A failed helper keeps its own words and category while its lead completes. Killed by taking
// the child's end from the lead's.
#[tokio::test(start_paused = true)]
async fn a_failed_helper_keeps_its_words_while_the_lead_completes() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    let child_run = session
        .start
        .routes
        .child_run_for(session.session_id, "helper")
        .expect("the helper has its child run");

    session.frame(&helper_ended("helper", "failed", "the build broke"));
    session.frame(&result(&json!({})));
    settle().await;

    let moves = session.engine.run_moves();
    let child_moves: Vec<_> = moves
        .iter()
        .filter(|change| change.run_id == child_run)
        .collect();
    assert!(
        matches!(
            child_moves.as_slice(),
            [change] if change.failure_category == Some(RunFailureCategory::ProviderFailure)
                && matches!(
                    &change.entry,
                    RunStateEntry::Failed { provider_failure_detail: Some(words), .. }
                        if words.as_str() == "the build broke"
                )
        ),
        "{child_moves:?}"
    );
    assert_eq!(
        session.engine.moves_of_run(lead_run),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// A helper's new own run clears a stop that is not final, a stop from the console holds, and a
// helper refused again is stopped again for that refusal. Killed by never clearing the stop
// (the token limit's case is denied), by clearing the console's stop, and by clearing after the
// refusal's stop (the refused-again case passes).
#[rstest]
#[case::token_limit(HelperStopReason::TokenLimit, false, None)]
#[case::setup_refused(
    HelperStopReason::SetupRefused { refusal: earlier_refusal() },
    false,
    None
)]
#[case::stop_all(HelperStopReason::StopAll, false, Some("will not be resumed"))]
#[case::refused_again(HelperStopReason::TokenLimit, true, Some("/gone/again.git"))]
#[tokio::test(start_paused = true)]
async fn a_new_own_run_clears_a_stop_that_is_not_final(
    #[case] stop: HelperStopReason,
    #[case] is_refused_again: bool,
    #[case] denial: Option<&str>,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    session.frame(&helper_ended("helper", "completed", "Reported"));
    settle().await;
    lock(&session.parts.run_controls.pauses).stop_helper(session.session_id, "helper", stop);
    if is_refused_again {
        session.engine.refuse_next_child_run(RunSetupRefusal {
            cause: "the writable root '/gone/again.git' could not be resolved".to_owned(),
            is_posture_rejection: false,
        });
    }

    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;

    match denial {
        Some(words) => assert!(is_denied_with(&session, "helper", words)),
        None => assert_eq!(
            helper_tool_answer(&session, "helper"),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
        ),
    }
}

// An interrupt's hold ends with the helper's run, so the first tool call of its next own run
// passes rather than being held with no `paused` reported. Killed by the hold kept past the end
// (the call is held).
#[tokio::test(start_paused = true)]
async fn an_interrupted_helpers_hold_ends_with_its_run() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    lock(&session.parts.run_controls.pauses).hold_interrupted_helper(&session.session_id, "helper");

    session.frame(&helper_ended("helper", "stopped", "Interrupted"));
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;

    assert_eq!(
        helper_tool_answer(&session, "helper"),
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
    );
}

// The refusal a helper's earlier run was stopped for.
fn earlier_refusal() -> RunSetupRefusal {
    RunSetupRefusal {
        cause: "the writable root '/gone/repo.git' could not be resolved".to_owned(),
        is_posture_rejection: false,
    }
}
