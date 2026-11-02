use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::integer::SafeInt;

use super::HOLD_RENEWAL_JOB;
use crate::driver::claude::hooks::pause::HELD_HELPER_RENEWAL_REASON;
use crate::driver::claude::hooks::registration::CLAUDE_HOOK_HOLD_RENEWAL_AFTER;
use crate::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::driver::claude::session::scripted::driver::create_params;
use crate::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::driver::run_control::{PauseRunParams, ResumeRunParams};
use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
use crate::run::state_entry::RunStateEntry;

// The helper's pre-tool callback `tool_use_id` for `tool_name`, through the hook `callback_id`.
fn helper_call(callback_id: &str, tool_name: &str, tool_use_id: &str) -> Value {
    json!({
        "subtype": "hook_callback",
        "callback_id": callback_id,
        "input": {
            "hook_event_name": "PreToolUse",
            "tool_name": tool_name,
            "tool_use_id": tool_use_id,
            "agent_id": "helper",
        },
    })
}

// The helper's shell call, through the pause's hook.
fn paused_hook_call() -> Value {
    helper_call("sidekicks-pause-before-tool", "Bash", "call-shell")
}

// The answer written to `request_id`, `None` while it is unanswered.
fn answer_of(session: &ScriptedSession, request_id: &str) -> Option<String> {
    session
        .channel
        .writes()
        .into_iter()
        .find_map(|write| match write {
            ScriptedWrite::Answer {
                request_id: answered,
                answer,
            } if answered == request_id => Some(answer.to_string()),
            ScriptedWrite::Answer { .. }
            | ScriptedWrite::Control(_)
            | ScriptedWrite::User(_)
            | ScriptedWrite::Terminate => None,
        })
}

// The renewals waiting on the driver's scheduler.
fn renewals_waiting(session: &ScriptedSession) -> usize {
    session
        .parts
        .establishment
        .task_services
        .scheduler
        .waiting_job_names()
        .into_iter()
        .filter(|name| *name == HOLD_RENEWAL_JOB)
        .count()
}

// Pauses the helper's run through the run controls, as a person's pause does.
fn pause(session: &ScriptedSession, helper: RunId) {
    session
        .parts
        .run_controls
        .pause_run(&PauseRunParams {
            session_id: session.session_id,
            run_id: helper,
        })
        .expect("the session is live");
}

// A paused helper's held call is denied, with the words that ask for it again, a day before
// Claude Code's own bound, and the call made again is held under the same pause, which reported
// its effect once, with a fresh renewal standing. Killed by arming no renewal (`r1` never
// answered), by one set at the bound itself (`r1` unanswered at the renewal's instant), by a
// renewal that ends the pause in place of taking its calls (`r2` answered), and by reporting the
// pause on every hold (a second `Paused`).
#[tokio::test(start_paused = true)]
async fn a_held_helper_call_is_denied_before_claude_codes_bound_and_held_again() {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    pause(&session, helper);
    session.request("r1", &paused_hook_call());
    settle().await;
    // Read after the renewal was armed, so it falls due at the latest a renewal's span from here.
    let now = SystemTime::now();
    session.wall_clock.set_now(now);
    assert_eq!(renewals_waiting(&session), 1);

    session
        .wall_clock
        .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER - Duration::from_mins(1));
    settle().await;
    assert_eq!(answer_of(&session, "r1"), None);

    session
        .wall_clock
        .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER);
    settle().await;
    let renewed = answer_of(&session, "r1").expect("the held call is answered at its renewal");
    assert!(renewed.contains(r#""permissionDecision":"deny""#));
    assert!(renewed.contains(HELD_HELPER_RENEWAL_REASON));

    session.request("r2", &paused_hook_call());
    settle().await;
    assert_eq!(
        answer_of(&session, "r2"),
        None,
        "the call made again is held"
    );
    let paused_moves = session
        .engine
        .moves_of_run(helper)
        .into_iter()
        .filter(|entry| matches!(entry, RunStateEntry::Paused))
        .count();
    assert_eq!(paused_moves, 1);
    assert_eq!(renewals_waiting(&session), 1);
}

// A renewal ends with the hold it renews, and a helper's start the helper limit holds arms none.
// Killed by a continue that leaves the renewal standing, and by arming a renewal on every hold.
#[tokio::test(start_paused = true)]
async fn a_renewal_ends_with_its_hold_and_a_helper_limit_hold_arms_none() {
    let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
        subagent_policy: Some(SubagentPolicy::Enabled {
            helpers_at_once: Some(SafeInt::new(1).expect("1 is a safe integer")),
            definitions: Vec::new(),
        }),
        ..create_params(session_id)
    })
    .await;
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    pause(&session, helper);
    session.request("r1", &paused_hook_call());
    settle().await;
    assert_eq!(renewals_waiting(&session), 1);

    session
        .parts
        .run_controls
        .resume_run(ResumeRunParams {
            session_id: session.session_id,
            run_id: helper,
            messages: Vec::new(),
        })
        .await
        .expect("the helper continues");
    assert_eq!(renewals_waiting(&session), 0);

    let helper_start =
        |tool_use_id: &str| helper_call("sidekicks-helper-limit", "Agent", tool_use_id);
    session.request("start-1", &helper_start("call-1"));
    session.request("start-2", &helper_start("call-2"));
    settle().await;
    assert!(answer_of(&session, "start-1").is_some());
    assert_eq!(
        answer_of(&session, "start-2"),
        None,
        "the second start is held"
    );
    assert_eq!(renewals_waiting(&session), 0);
}
