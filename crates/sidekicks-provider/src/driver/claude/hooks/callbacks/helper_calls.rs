//! The routes of the helper calls the daemon checks before Claude Code runs them: a helper start
//! against the session's posture, a message aimed at a helper against the person's stops and
//! pauses, and a message that wakes an ended helper against the session's helper limit.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::{ClaudeRequestRoute, route_before_tool};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::hooks::helper_limit::{
    ClaudeCountedProcess, ClaudeHelperLimit, ClaudeHelperStartAnswer,
};
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::run_control::HelperStopReason;
use crate::driver::session_messages::target_unread_reason;
use crate::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
use crate::run::posture::resolve_posture;

/// What the session's own checks find of a message call aimed at a helper.
pub(crate) enum ClaudeMessageTarget {
    /// The checks deny it in the answer's words: the caller is stopped, or the target is stopped
    /// with every other agent or held by a pause or an interrupt.
    Denied(ClaudeHookAnswer),
    /// The target's stored stop could not be read: the reason the call is denied with.
    Unread(String),
    /// The checks let it through: the helper the session's agent tree holds under the target's
    /// name, `None` where it holds none or no tree is registered.
    Open(Option<AgentTreeHelper>),
}

/// The route of a helper start, the call `request_id` of the helper tool by the helper `agent_id`
/// or the lead, once the session's `posture` is checked: denied, with the refusal's cause in the
/// reason the agent reads, where the posture no longer resolves; otherwise, or where the session
/// holds no posture, answered or held as the pause says. Only a writable root costs a path read,
/// so only Sandboxed reads any; `pauses` is locked only after the read.
pub(crate) async fn route_helper_start(
    posture: Option<&ExecutionPosture>,
    pauses: &Mutex<ClaudeRunPauses>,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<String>,
) -> ClaudeRequestRoute {
    if let Some(posture) = posture
        && let Err(rejection) = resolve_posture(posture).await
    {
        return ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Deny {
                reason: helper_start_refused_reason(&describe_error(&rejection)),
            },
        };
    }
    route_before_tool(&mut lock(pauses), session_id, request_id, agent_id, None)
}

// The reason a refused helper start gives the agent, `cause` saying why the level cannot run.
pub(super) fn helper_start_refused_reason(cause: &str) -> String {
    format!(
        "Not started: this session's permission level cannot run right now, because {cause}. \
         Continue without a helper, or tell the person."
    )
}

/// Checks a message call by the helper `agent_id` or the lead aimed at the helper `to`, as the
/// session's process and its one-turn copies check it: a stopped caller is denied with its own
/// stop's sentence; a target stopped with every other agent, in memory or, once its process or the
/// daemon restarted, by the stop its newest own run stored through `lookup`, with that stop's
/// sentence; one a pause or an interrupt holds with [`HELD_TARGET_REASON`]; a failed read with its
/// cause. A `to` naming the lead or no helper finds none. `pauses` is never locked across the
/// read.
///
/// [`HELD_TARGET_REASON`]: crate::driver::hook_pauses::HELD_TARGET_REASON
pub(crate) async fn check_message_target(
    lookup: Option<Arc<dyn AgentTreeLookup>>,
    pauses: &Mutex<ClaudeRunPauses>,
    session_id: &SessionId,
    agent_id: Option<&str>,
    to: &str,
) -> ClaudeMessageTarget {
    if let Some(answer) = lock(pauses).answer_aimed_call(session_id, agent_id, to) {
        return ClaudeMessageTarget::Denied(answer);
    }
    let Some(lookup) = lookup else {
        return ClaudeMessageTarget::Open(None);
    };
    let stored = lookup
        .helper_by_subagent_id(*session_id, DESCRIPTOR.provider_id(), to.to_owned())
        .await;
    match stored {
        Ok(Some(helper)) if is_stopped_with_all(&helper) => {
            ClaudeMessageTarget::Denied(ClaudeHookAnswer::Deny {
                reason: HelperStopReason::StopAll.sentence(),
            })
        }
        Ok(helper) => ClaudeMessageTarget::Open(helper),
        Err(error) => ClaudeMessageTarget::Unread(target_unread_reason(&describe_error(&*error))),
    }
}

/// The route of a message call `request_id` by the helper `agent_id` or the lead, aimed at the
/// helper `to`: denied as [`check_message_target`] denies it, and otherwise answered or held as
/// the pause says.
pub(crate) async fn route_message_target(
    lookup: Option<Arc<dyn AgentTreeLookup>>,
    pauses: &Mutex<ClaudeRunPauses>,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<String>,
    to: String,
) -> ClaudeRequestRoute {
    let answer = match check_message_target(lookup, pauses, session_id, agent_id.as_deref(), &to)
        .await
    {
        ClaudeMessageTarget::Denied(answer) => answer,
        ClaudeMessageTarget::Unread(reason) => ClaudeHookAnswer::Deny { reason },
        ClaudeMessageTarget::Open(_) => {
            return route_before_tool(&mut lock(pauses), session_id, request_id, agent_id, None);
        }
    };
    ClaudeRequestRoute::Answer { request_id, answer }
}

/// The route of a message call `request_id`, the tool call `tool_use_id` by the helper `agent_id`
/// or the lead, aimed at the helper `to`, which wakes it when it has ended: a helper the tree
/// holds whose newest own run ended counts against the session's helper limit as a new start
/// does, admitted while the session has room and held otherwise. A call [`check_message_target`]
/// denies passes uncounted, since it wakes nothing, and so does one aimed at a helper a pause or
/// an interrupt came to hold during the read, whose interrupted run has not ended. A running
/// helper, an id the tree does not hold or a tree not yet registered passes; a failed read is
/// denied with its cause. Neither lock is held across the read, and `pauses` is taken before
/// `helpers`, as every route takes them.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's ids and the stores it reads, each a separate input"
)]
pub(crate) async fn route_helper_wake(
    lookup: Option<Arc<dyn AgentTreeLookup>>,
    pauses: &Mutex<ClaudeRunPauses>,
    helpers: &Mutex<ClaudeHelperLimit>,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<&str>,
    tool_use_id: &str,
    to: &str,
) -> ClaudeRequestRoute {
    let pass = |request_id| ClaudeRequestRoute::Answer {
        request_id,
        answer: ClaudeHookAnswer::Pass,
    };
    match check_message_target(lookup, pauses, session_id, agent_id, to).await {
        ClaudeMessageTarget::Open(Some(helper)) if helper.own_run_state.is_terminal() => {
            let pauses = lock(pauses);
            if helper.own_run_state == RunState::Interrupted
                && pauses.is_helper_held(session_id, to)
            {
                return pass(request_id);
            }
            let own = ClaudeCountedProcess::Session;
            let answer = lock(helpers).answer_start(session_id, own, &request_id, tool_use_id);
            helper_limit_route(answer, request_id)
        }
        ClaudeMessageTarget::Open(_) | ClaudeMessageTarget::Denied(_) => pass(request_id),
        ClaudeMessageTarget::Unread(reason) => ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Deny { reason },
        },
    }
}

// Whether the stored helper was stopped with every other agent, by the stop its newest own run
// stored, which no message wakes.
fn is_stopped_with_all(helper: &AgentTreeHelper) -> bool {
    matches!(helper.own_run_stop_trigger, Some(StopTrigger::StopAll))
}

// The helper limit's route for a start or a wake: a pass now, or a hold the limit releases.
pub(super) fn helper_limit_route(
    answer: ClaudeHelperStartAnswer,
    request_id: String,
) -> ClaudeRequestRoute {
    match answer {
        ClaudeHelperStartAnswer::Admit => ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Pass,
        },
        ClaudeHelperStartAnswer::Hold => ClaudeRequestRoute::Held { helper: None },
    }
}
