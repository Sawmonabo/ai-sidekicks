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
use sidekicks_std::scheduler::{JobCondition, Scheduler};

use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::hooks::registration::CLAUDE_HOOK_HOLD_RENEWAL_AFTER;
use crate::driver::claude::session::slots::ClaudeSessionSlots;

/// The renewal job's name in the program's log.
const HOLD_RENEWAL_JOB: &str = "claude-hold-renewal";

/// Arms the renewal of the helper `agent_id`'s held calls on `session_id`, unless one stands: when
/// it falls due, each call the helper's pause holds then is denied for the helper to make again.
/// A renewal the scheduler refuses is written to the log; the hold then ends at Claude Code's own
/// bound.
pub(crate) fn arm_hold_renewal(
    scheduler: &Scheduler,
    pauses: &Arc<Mutex<ClaudeRunPauses>>,
    slots: &ClaudeSessionSlots,
    session_id: SessionId,
    agent_id: String,
) {
    let mut held = lock(pauses);
    if held.has_renewal(&session_id, &agent_id) {
        return;
    }
    let job_pauses = Arc::clone(pauses);
    let slots = slots.clone();
    let job_agent_id = agent_id.clone();
    let scheduled = scheduler.schedule_at(
        HOLD_RENEWAL_JOB,
        JobCondition::Always,
        SystemTime::now() + CLAUDE_HOOK_HOLD_RENEWAL_AFTER,
        move |_| {
            let calls = lock(&job_pauses).take_renewed_calls(&session_id, &job_agent_id);
            // The answers are written off the scheduler's one task, which never waits on a
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
        Ok(renewal) => held.keep_renewal(session_id, agent_id, renewal),
        Err(error) => tracing::warn!(
            session_id = %session_id,
            error = &error as &(dyn Error + 'static),
            "a held helper's call could not be renewed, so its hold ends at Claude Code's own bound"
        ),
    }
}

#[cfg(test)]
mod tests;
