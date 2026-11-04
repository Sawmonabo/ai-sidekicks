//! A helper that ended can be started again inside the same process, by a `SendMessage` the lead
//! or another helper sent it, or by Claude Code itself after a worker restart, which names the
//! call that started the helper's newest own run. The stream keeps each helper's newest own run
//! with the run it went beneath, and each `SendMessage` call read with the run it was read on, so
//! a resume goes beneath the run that sent its message, else beneath its previous own run's
//! parent. Both live in the session's stream and go with it; the calls go as the lead's next turn
//! opens.

use std::collections::HashMap;

use sidekicks_contracts::run::id::RunId;

use super::body::ClaudeFrameBody;
use super::{ClaudeDeliveryStream, ClaudeSessionStream, bound};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::hooks::registration::CLAUDE_MESSAGE_TOOL_NAME;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute, ClaudeRunRoutes};
use crate::driver::claude::session::arrivals::ClaudeTurnAtRead;
use crate::run::delivery::{InboundDelivery, InboundOutcome};
use crate::thread_frame_router::ThreadFrameRoute;

#[cfg(test)]
mod tests;

/// A session's helpers as their resumes read them: each helper's newest own run, by agent id, and
/// each `SendMessage` call read since the lead's turn opened, by call id, with the run it was read
/// on.
#[derive(Debug, Default)]
pub(crate) struct ClaudeHelperResumes {
    /// Each helper's newest own run, by agent id.
    helpers: HashMap<String, ClaudeHelperRecord>,
    /// Each `SendMessage` call read and not yet taken by a resume, with the run it was read on.
    message_calls: HashMap<String, ClaudeBoundRun>,
}

/// A helper's newest own run.
#[derive(Debug)]
struct ClaudeHelperRecord {
    /// The call its start named.
    start_call_id: Option<String>,
    /// The run.
    run_id: RunId,
    /// The run it went beneath.
    parent: ClaudeBoundRun,
    /// Whether it ended interrupted.
    is_interrupted: bool,
}

/// What a resumed helper's start reads of its helper: the run its call names, where the call is
/// read or names the helper's newest own start, and the helper's previous own run where it ended
/// interrupted.
#[derive(Debug)]
pub(super) struct ClaudeHelperResume {
    /// The run that sent the resuming message, else the previous own run's parent for a resume
    /// naming that run's start; `None` when the call is not read, or its run can carry no start.
    pub(super) carrier: Option<ClaudeBoundRun>,
    /// The previous own run and the run it went beneath, where it ended interrupted.
    interrupted: Option<(RunId, RunId)>,
}

impl ClaudeHelperResume {
    /// The helper's previous own run, where it ended interrupted beneath `carrier_run_id`, so the
    /// resume continues it.
    pub(super) fn interrupted_run_beneath(&self, carrier_run_id: RunId) -> Option<RunId> {
        self.interrupted
            .filter(|(_, parent_run_id)| *parent_run_id == carrier_run_id)
            .map(|(run_id, _)| run_id)
    }
}

impl ClaudeHelperResumes {
    /// The resume of the helper `agent_id` started under the call `call_id`, or `None` for a
    /// helper with no own run yet. A `SendMessage` call it names is taken; a run that has ended,
    /// as the routes read it, carries nothing.
    pub(super) fn resume_of(
        &mut self,
        routes: &ClaudeRunRoutes,
        agent_id: &str,
        call_id: Option<&str>,
    ) -> Option<ClaudeHelperResume> {
        let record = self.helpers.get(agent_id)?;
        let carrier = match call_id.and_then(|call_id| self.message_calls.remove(call_id)) {
            Some(call_run) => Some(call_run),
            None => (call_id.is_some() && call_id == record.start_call_id.as_deref())
                .then(|| record.parent.clone()),
        };
        Some(ClaudeHelperResume {
            carrier: carrier.filter(|carrier| can_carry(routes, carrier.run_id)),
            interrupted: record
                .is_interrupted
                .then_some((record.run_id, record.parent.run_id)),
        })
    }

    /// Records the helper `agent_id`'s newest own run `run_id`, started under `start_call_id`
    /// beneath `parent`.
    pub(super) fn record_start(
        &mut self,
        agent_id: &str,
        start_call_id: Option<&str>,
        run_id: RunId,
        parent: ClaudeBoundRun,
    ) {
        self.helpers.insert(
            agent_id.to_owned(),
            ClaudeHelperRecord {
                start_call_id: start_call_id.map(str::to_owned),
                run_id,
                parent,
                is_interrupted: false,
            },
        );
    }

    /// Records how the helper `agent_id`'s own run `run_id` ended, where it is still the newest.
    pub(super) fn record_end(&mut self, agent_id: &str, run_id: RunId, is_interrupted: bool) {
        if let Some(record) = self.helpers.get_mut(agent_id)
            && record.run_id == run_id
        {
            record.is_interrupted = is_interrupted;
        }
    }

    /// Forgets the `SendMessage` calls read, as the lead's next turn opens.
    pub(crate) fn clear_message_calls(&mut self) {
        self.message_calls.clear();
    }
}

impl ClaudeDeliveryStream {
    // Records each `SendMessage` call an assistant frame of `kind` starts, with the run it is read
    // on: the bound run of the helper whose frame it is, else the lead run that held the turn as
    // the frame was read. A call read on no run is not recorded.
    pub(super) fn read_message_calls(
        &self,
        session: &ClaudeSessionStream,
        kind: &ClaudeWireFrameKind,
        route: &ThreadFrameRoute,
        body: &ClaudeFrameBody,
        turn_at_read: &ClaudeTurnAtRead,
    ) {
        let (ClaudeWireFrameKind::Assistant, ClaudeFrameBody::Message(message)) = (kind, body)
        else {
            return;
        };
        let mut calls = message
            .tool_uses()
            .filter(|(_, tool_name, _)| *tool_name == CLAUDE_MESSAGE_TOOL_NAME)
            .map(|(call_id, ..)| call_id)
            .peekable();
        if calls.peek().is_none() {
            return;
        }
        let helper_run = if let ThreadFrameRoute::ChildTranscript { child_thread_id } = route {
            self.helper_run(session, child_thread_id)
        } else {
            None
        };
        let Some(call_run) = helper_run.or_else(|| turn_at_read.lead.clone()) else {
            return;
        };
        let mut readings = session.lock();
        for call_id in calls {
            readings
                .helper_resumes
                .message_calls
                .insert(call_id.to_owned(), call_run.clone());
        }
    }

    // Continues the helper's interrupted own run `run_id` beneath `carrier`, on its binding;
    // answers the run where the engine moved it, and `None` where it no longer reads interrupted
    // or the delivery failed.
    pub(super) async fn continue_helper_run(
        &self,
        session: &ClaudeSessionStream,
        carrier: &ClaudeBoundRun,
        run_id: RunId,
    ) -> Option<RunId> {
        let delivery = InboundDelivery::RunContinued {
            binding: bound(&ClaudeBoundRun {
                run_id,
                binding_id: carrier.binding_id.clone(),
            }),
            run_id,
        };
        let outcome = self
            .send(session, delivery, Some("system/task_started"))
            .await;
        matches!(outcome, Some(InboundOutcome::Transitioned { .. })).then_some(run_id)
    }
}

// Whether `run_id` can still carry a helper's start: a lead run while it is bound, or a helper's
// child run while its helper runs and the daemon did not refuse it. The engine writes no start
// beneath a run that has ended.
fn can_carry(routes: &ClaudeRunRoutes, run_id: RunId) -> bool {
    match routes.route_of(run_id) {
        Some(ClaudeRunRoute::Lead { .. }) => true,
        Some(ClaudeRunRoute::Child(route)) => !route.is_refused,
        Some(ClaudeRunRoute::Apart) | None => false,
    }
}
