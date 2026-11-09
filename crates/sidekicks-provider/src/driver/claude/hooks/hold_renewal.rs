//! The renewal of a held helper's call. Claude Code waits on a held callback only up to its own
//! bound, past which it blocks the call in its own words; a day before that, the daemon denies the
//! call so the helper makes it again, and the pause, still in force, holds it for a fresh bound.
//! The job runs on the wall clock, which keeps counting while the machine sleeps, as Claude Code's
//! own timer does.

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::FutureExt;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, Scheduler};

use crate::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::hooks::registration::CLAUDE_HOOK_HOLD_RENEWAL_AFTER;
use crate::driver::claude::session::slots::ClaudeSessionSlots;

/// The renewal job's name in the program's log.
const HOLD_RENEWAL_JOB: &str = "claude-hold-renewal";

/// Arms the renewal of the helper `agent_id`'s held calls on `session_id`, unless one stands: when
/// it falls due, each call the helper's pause holds then is denied for the helper to make again,
/// and `stream` forgets what a denied helper call asked for. A renewal the scheduler refuses, at
/// once or when it arms the timer, is written to the log and dropped, so the next hold arms
/// another; the hold then ends at Claude Code's own bound.
pub(crate) fn arm_hold_renewal(
    scheduler: &Scheduler,
    pauses: &Arc<Mutex<ClaudeRunPauses>>,
    slots: &ClaudeSessionSlots,
    stream: &Arc<ClaudeSessionStream>,
    session_id: SessionId,
    agent_id: String,
) {
    let mut held = lock(pauses);
    if held.has_renewal(&session_id, &agent_id) {
        return;
    }
    let renewal_id = held.mint_renewal_id();
    let job_pauses = Arc::clone(pauses);
    let slots = slots.clone();
    let job_agent_id = agent_id.clone();
    let job_stream = Arc::clone(stream);
    let scheduled = scheduler.schedule_at(
        HOLD_RENEWAL_JOB,
        JobCondition::Always,
        SystemTime::now() + CLAUDE_HOOK_HOLD_RENEWAL_AFTER,
        move |_| {
            let calls =
                lock(&job_pauses).take_renewed_calls(&session_id, &job_agent_id, renewal_id);
            for call in &calls {
                job_stream.forget_helper_call_of_request(&call.request_id);
            }
            // The answers are written off the scheduler's task, which never waits on a
            // process's write.
            if !calls.is_empty()
                && let Some(live) = slots.live_session(session_id)
            {
                tokio::spawn(async move {
                    let account = live.admitted_provider_account_id();
                    for call in calls {
                        answer_claude_request(
                            &*live.channel,
                            &session_id,
                            &account,
                            call.request_id,
                            &call.answer,
                        )
                        .await;
                    }
                });
            }
            async { Ok(()) }.boxed()
        },
    );
    match scheduled {
        Ok(mut renewal) => {
            let refusal = renewal.refusal();
            held.keep_renewal(session_id, agent_id.clone(), renewal_id, renewal);
            let refusal_pauses = Arc::clone(pauses);
            tokio::spawn(async move {
                if let Some(error) = refusal.await {
                    lock(&refusal_pauses).drop_renewal(&session_id, &agent_id, renewal_id);
                    warn_unrenewed(session_id, &error);
                }
            });
        }
        Err(error) => warn_unrenewed(session_id, &error),
    }
}

// Writes the scheduler's refusal of a renewal to the log.
fn warn_unrenewed(session_id: SessionId, error: &ScheduleError) {
    tracing::warn!(
        session_id = %session_id,
        error = error as &(dyn Error + 'static),
        "a held helper's call could not be renewed, so its hold ends at Claude Code's own bound"
    );
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use serde_json::{Value, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::HOLD_RENEWAL_JOB;
    use crate::driver::claude::hooks::pause::HELD_HELPER_RENEWAL_REASON;
    use crate::driver::claude::hooks::registration::CLAUDE_HOOK_HOLD_RENEWAL_AFTER;
    use crate::driver::claude::session::scripted::driver::create_params;
    use crate::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::driver::run_control::{PauseRunParams, ResumeRunParams};
    use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
    use crate::run::state_entry::RunStateEntry;

    // The helper `agent_id`'s pre-tool callback `tool_use_id` for `tool_name`, through the hook
    // `callback_id`.
    fn helper_call(agent_id: &str, callback_id: &str, tool_name: &str, tool_use_id: &str) -> Value {
        json!({
            "subtype": "hook_callback",
            "callback_id": callback_id,
            "input": {
                "hook_event_name": "PreToolUse",
                "tool_name": tool_name,
                "tool_use_id": tool_use_id,
                "agent_id": agent_id,
            },
        })
    }

    // The helper `agent_id`'s shell call `tool_use_id`, through the pause's hook.
    fn paused_hook_call(agent_id: &str, tool_use_id: &str) -> Value {
        helper_call(agent_id, "sidekicks-pause-before-tool", "Bash", tool_use_id)
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
    // renewal that ends the pause in place of taking its calls (`r2` answered), and by reporting
    // the pause on every hold (a second `Paused`).
    #[tokio::test(start_paused = true)]
    async fn a_held_helper_call_is_denied_before_claude_codes_bound_and_held_again() {
        let session = ScriptedSession::new().await;
        let lead = session.hold_lead_turn("lead");
        let helper = session.bind_helper(lead, "helper");
        pause(&session, helper);
        session.request("r1", &paused_hook_call("helper", "call-shell"));
        settle().await;
        // Read after the renewal was armed, so it falls due at the latest a renewal's span from
        // here.
        let now = SystemTime::now();
        session.wall_clock.set_now(now);
        assert_eq!(renewals_waiting(&session), 1);

        session
            .wall_clock
            .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER - Duration::from_mins(1));
        settle().await;
        assert_eq!(session.channel.written_answer("r1"), None);

        session
            .wall_clock
            .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER);
        settle().await;
        let renewed = session
            .channel
            .written_answer("r1")
            .expect("the held call is answered at its renewal")
            .to_string();
        assert!(renewed.contains(r#""permissionDecision":"deny""#));
        assert!(renewed.contains(HELD_HELPER_RENEWAL_REASON));

        session.request("r2", &paused_hook_call("helper", "call-shell"));
        settle().await;
        assert_eq!(
            session.channel.written_answer("r2"),
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

    // A renewal ends with the hold it renews, and a helper's start the helper limit holds arms
    // none. Killed by a continue that leaves the renewal standing, and by arming a renewal on every
    // hold.
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
        session.request("r1", &paused_hook_call("helper", "call-shell"));
        settle().await;
        assert_eq!(renewals_waiting(&session), 1);

        session
            .parts
            .run_controls
            .resume_run(ResumeRunParams {
                session_id: session.session_id,
                run_id: helper,
                messages: Vec::new(),
                is_continuation_owed: false,
            })
            .await
            .expect("the helper continues");
        assert_eq!(renewals_waiting(&session), 0);

        let helper_start = |tool_use_id: &str| {
            helper_call("helper", "sidekicks-helper-limit", "Agent", tool_use_id)
        };
        session.request("start-1", &helper_start("call-1"));
        session.request("start-2", &helper_start("call-2"));
        settle().await;
        assert!(session.channel.written_answer("start-1").is_some());
        assert_eq!(
            session.channel.written_answer("start-2"),
            None,
            "the second start is held"
        );
        assert_eq!(renewals_waiting(&session), 0);
    }

    // A renewal whose timer the system later refuses is dropped, so the helper's next held call
    // arms another. Killed by leaving the refused renewal standing (no renewal armed for the call
    // made again).
    #[tokio::test(start_paused = true)]
    async fn a_renewal_the_timer_refuses_is_armed_again_at_the_next_hold() {
        let session = ScriptedSession::new().await;
        let lead = session.hold_lead_turn("lead");
        let first = session.bind_helper(lead, "helper");
        let second = session.bind_helper(lead, "helper-b");
        pause(&session, first);
        pause(&session, second);
        session.request("r1", &paused_hook_call("helper", "call-1"));
        settle().await;
        // Read after the first renewal was armed and before the second, so only the first falls due
        // a renewal's span from here.
        let now = SystemTime::now();
        session.wall_clock.set_now(now);
        session.wall_clock.refuse_arms(true);
        session.request("r2", &paused_hook_call("helper-b", "call-2"));
        settle().await;
        assert_eq!(renewals_waiting(&session), 2);

        session
            .wall_clock
            .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER);
        settle().await;
        assert!(session.channel.written_answer("r1").is_some());
        assert_eq!(
            renewals_waiting(&session),
            0,
            "the second renewal's timer is refused once the first ran"
        );

        session.wall_clock.refuse_arms(false);
        session.request("r3", &paused_hook_call("helper-b", "call-3"));
        settle().await;
        assert_eq!(renewals_waiting(&session), 1);
    }
}
