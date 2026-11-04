//! A helper that ended can be started again inside the same process, by a `SendMessage` the lead
//! or another helper sent it, or by Claude Code itself after a worker restart, which names the
//! call that started the helper's newest own run. The stream keeps each helper's newest own run
//! with the run it went beneath, and each `SendMessage` call read with the run it was read on, so
//! a resume goes beneath the run that sent its message, else beneath its previous own run's
//! parent. A resume naming a call not read yet is parked: the call, once read, delivers it beneath
//! its own run; the helper's next frame or its end, if first, delivers it beneath the run a first
//! start takes, and the call then moves the child run beneath its own run once. All of it lives in
//! the session's stream and goes with it; the calls and the moves still owed go as the lead's next
//! turn opens.

use std::collections::HashMap;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;

use super::body::ClaudeFrameBody;
use super::{ClaudeDeliveryStream, ClaudeSessionStream, bound};
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::event_normalizer::{ClaudeSubagentLifecycleSignal, ClaudeWireFrameKind};
use crate::driver::claude::hooks::registration::CLAUDE_MESSAGE_TOOL_NAME;
use crate::driver::claude::run::routes::{
    ClaudeBoundRun, ClaudeChildRunRoute, ClaudeRunRoute, ClaudeRunRoutes,
};
use crate::driver::claude::session::arrivals::ClaudeTurnAtRead;
use crate::run::delivery::{InboundDelivery, InboundOutcome};
use crate::thread_frame_router::{SubagentLifecycleEmission, ThreadFrameRoute};

#[cfg(test)]
mod tests;

/// A session's helpers as their resumes read them: each helper's newest own run, by agent id;
/// each `SendMessage` call read since the lead's turn opened, by call id, with the run it was read
/// on; each resume parked for its call, by agent id; and each move a call still owes a child run,
/// by call id.
#[derive(Debug, Default)]
pub(crate) struct ClaudeHelperResumes {
    /// Each helper's newest own run, by agent id.
    helpers: HashMap<String, ClaudeHelperRecord>,
    /// Each `SendMessage` call read and not yet taken by a resume, with the run it was read on.
    message_calls: HashMap<String, ClaudeBoundRun>,
    /// Each resume whose call is not read yet, by agent id.
    parked_starts: HashMap<String, ClaudeParkedStart>,
    /// Each child run a parked resume was given before its call was read, by that call's id.
    pending_corrections: HashMap<String, ClaudePendingCorrection>,
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

impl ClaudeHelperRecord {
    // Its helper's resume beneath `carrier`, where that run can still carry a start.
    fn resume(
        &self,
        routes: &ClaudeRunRoutes,
        carrier: Option<ClaudeBoundRun>,
        is_awaiting_call: bool,
    ) -> ClaudeHelperResume {
        ClaudeHelperResume {
            carrier: carrier.filter(|carrier| can_carry(routes, carrier.run_id)),
            is_awaiting_call,
            interrupted: self
                .is_interrupted
                .then_some((self.run_id, self.parent.run_id)),
        }
    }
}

/// What a resumed helper's start reads of its helper: the run its call names, where the call is
/// read or names the helper's newest own start, whether it waits for a call not read yet, and the
/// helper's previous own run where it ended interrupted.
#[derive(Debug)]
pub(super) struct ClaudeHelperResume {
    /// The run that sent the resuming message, else the previous own run's parent for a resume
    /// naming that run's start; `None` when the call is not read, or its run can carry no start.
    pub(super) carrier: Option<ClaudeBoundRun>,
    /// Whether it names a call that is neither read nor the newest own start's, so it is parked.
    pub(super) is_awaiting_call: bool,
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

/// A resumed helper's start parked until the call it names is read, or the helper's next frame or
/// its end comes first.
#[derive(Debug)]
pub(super) struct ClaudeParkedStart {
    /// The helper's id as the transcript holds it.
    pub(super) subagent_id: SubagentId,
    /// The start, which names the call it waits for.
    pub(super) emission: SubagentLifecycleEmission,
    /// The lifecycle signal its frame carried.
    pub(super) signal: Option<ClaudeSubagentLifecycleSignal>,
    /// The lead run that held the turn as it was read.
    pub(super) lead_at_read: Option<ClaudeBoundRun>,
}

/// A resumed helper's child run delivered before the call naming it was read, which that call
/// moves beneath its own run once.
#[derive(Debug)]
struct ClaudePendingCorrection {
    /// The helper's agent id.
    agent_id: String,
    /// The child run its start was given.
    child_run_id: RunId,
    /// The run that start went beneath.
    carrier: ClaudeBoundRun,
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
        let call_run = call_id.and_then(|call_id| self.message_calls.remove(call_id));
        let is_start_call = call_id.is_some() && call_id == record.start_call_id.as_deref();
        let is_awaiting_call = call_id.is_some() && call_run.is_none() && !is_start_call;
        let carrier = call_run.or_else(|| is_start_call.then(|| record.parent.clone()));
        Some(record.resume(routes, carrier, is_awaiting_call))
    }

    /// Parks a resume whose call is not read yet.
    pub(super) fn park(&mut self, start: ClaudeParkedStart) {
        self.parked_starts
            .insert(start.emission.subagent_id.clone(), start);
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

    /// Forgets the `SendMessage` calls read and the moves still owed to calls not read, as the
    /// lead's next turn opens.
    pub(crate) fn clear_message_calls(&mut self) {
        self.message_calls.clear();
        self.pending_corrections.clear();
    }

    // Moves the helper `agent_id`'s newest own run `run_id` beneath `parent`, where it is still the
    // newest.
    fn record_parent(&mut self, agent_id: &str, run_id: RunId, parent: ClaudeBoundRun) {
        if let Some(record) = self.helpers.get_mut(agent_id)
            && record.run_id == run_id
        {
            record.parent = parent;
        }
    }

    // Takes the `SendMessage` calls `message` starts, read on `call_run`: answers the starts parked
    // for them and the moves they owe, and records each other call for a later resume.
    fn take_message_calls(
        &mut self,
        message: &ClaudeMessageFrame,
        call_run: &ClaudeBoundRun,
    ) -> (Vec<ClaudeParkedStart>, Vec<ClaudePendingCorrection>) {
        let mut parked_starts = Vec::new();
        let mut corrections = Vec::new();
        for call_id in message_call_ids(message) {
            if let Some(parked) = self.take_parked_for_call(call_id) {
                parked_starts.push(parked);
            } else if let Some(correction) = self.pending_corrections.remove(call_id) {
                corrections.push(correction);
            } else {
                self.message_calls
                    .insert(call_id.to_owned(), call_run.clone());
            }
        }
        (parked_starts, corrections)
    }

    // Takes the start parked for the call `call_id`.
    fn take_parked_for_call(&mut self, call_id: &str) -> Option<ClaudeParkedStart> {
        self.parked_starts
            .extract_if(|_, parked| parked.emission.parent_tool_call_id.as_deref() == Some(call_id))
            .next()
            .map(|(_, parked)| parked)
    }
}

impl ClaudeDeliveryStream {
    // Reads a frame for the helpers' resumes. A helper's own frame first delivers its parked
    // start. Each `SendMessage` call an assistant frame of `kind` starts is read on the bound run
    // of the helper whose frame it is, else the lead run that held the turn as the frame was read:
    // it delivers the start parked for it beneath that run, moves the child run a start delivered
    // before it went beneath another run, or else is recorded for a later resume. A call read on
    // no run does none of these.
    pub(super) async fn read_resume_frame(
        &self,
        session: &ClaudeSessionStream,
        kind: &ClaudeWireFrameKind,
        route: &ThreadFrameRoute,
        body: &ClaudeFrameBody,
        turn_at_read: &ClaudeTurnAtRead,
    ) {
        let helper_id = if let ThreadFrameRoute::ChildTranscript { child_thread_id } = route {
            Some(child_thread_id.as_str())
        } else {
            None
        };
        if let Some(helper_id) = helper_id {
            self.flush_parked_start(session, helper_id).await;
        }
        let (ClaudeWireFrameKind::Assistant, ClaudeFrameBody::Message(message)) = (kind, body)
        else {
            return;
        };
        if message_call_ids(message).next().is_none() {
            return;
        }
        let Some(call_run) = helper_id
            .and_then(|helper_id| self.helper_run(session, helper_id))
            .or_else(|| turn_at_read.lead.clone())
        else {
            return;
        };
        let (parked_starts, corrections) = session
            .lock()
            .helper_resumes
            .take_message_calls(message, &call_run);
        for parked in parked_starts {
            self.deliver_parked_start(session, parked, Some(call_run.clone()))
                .await;
        }
        for correction in corrections {
            self.correct_helper_parent(session, correction, &call_run)
                .await;
        }
    }

    // Delivers the start parked for the helper `agent_id`, if one waits, beneath the run a first
    // start takes now, keeping the move its call owes.
    pub(super) async fn flush_parked_start(&self, session: &ClaudeSessionStream, agent_id: &str) {
        let parked = session.lock().helper_resumes.parked_starts.remove(agent_id);
        if let Some(parked) = parked {
            self.deliver_parked_start(session, parked, None).await;
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

    // Delivers a parked start beneath `call_run`, the run that read its call, where that run can
    // still carry it, else beneath the run a first start takes, under the lead holding the turn
    // now, else the one that held it as the start was read. A start delivered before its call was
    // read keeps the move that call owes its child run.
    async fn deliver_parked_start(
        &self,
        session: &ClaudeSessionStream,
        parked: ClaudeParkedStart,
        call_run: Option<ClaudeBoundRun>,
    ) {
        let ClaudeParkedStart {
            subagent_id,
            emission,
            signal,
            lead_at_read,
        } = parked;
        let routes = &self.dependencies.routes;
        let turn_lead = routes.lead_run_on(session.session_id).or(lead_at_read);
        let is_before_call = call_run.is_none();
        let resume = session
            .lock()
            .helper_resumes
            .helpers
            .get(&emission.subagent_id)
            .map(|record| record.resume(routes, call_run, false));
        let started = self
            .start_helper(
                session,
                turn_lead.as_ref(),
                resume.as_ref(),
                signal.as_ref(),
                &emission,
                subagent_id,
            )
            .await;
        if is_before_call
            && let Some((child_run_id, carrier)) = started
            && let Some(call_id) = emission.parent_tool_call_id
        {
            session.lock().helper_resumes.pending_corrections.insert(
                call_id,
                ClaudePendingCorrection {
                    agent_id: emission.subagent_id,
                    child_run_id,
                    carrier,
                },
            );
        }
    }

    // Moves the child run a resume was given before its call was read beneath `call_run`, the run
    // that read the call, where that run is not the one it went beneath. Once the engine wrote the
    // move, the helper's route and its newest own run go beneath `call_run`, so its end row goes
    // there; a refused move is the dispatch's to report, and is not retried.
    async fn correct_helper_parent(
        &self,
        session: &ClaudeSessionStream,
        correction: ClaudePendingCorrection,
        call_run: &ClaudeBoundRun,
    ) {
        let ClaudePendingCorrection {
            agent_id,
            child_run_id,
            carrier,
        } = correction;
        if carrier.run_id == call_run.run_id {
            return;
        }
        let delivery = InboundDelivery::ChildRunParentCorrected {
            binding: bound(&ClaudeBoundRun {
                run_id: child_run_id,
                binding_id: carrier.binding_id,
            }),
            child_run_id,
            parent_run_id: call_run.run_id,
        };
        let outcome = self.send(session, delivery, Some("assistant")).await;
        if !matches!(outcome, Some(InboundOutcome::Appended { .. })) {
            return;
        }
        let routes = &self.dependencies.routes;
        if let Some((run_id, route)) = routes.child_route_for(session.session_id, &agent_id)
            && run_id == child_run_id
        {
            routes.bind_child_run(
                run_id,
                ClaudeChildRunRoute {
                    parent_run_id: call_run.run_id,
                    binding_id: call_run.binding_id.clone(),
                    ..route
                },
            );
        }
        session
            .lock()
            .helper_resumes
            .record_parent(&agent_id, child_run_id, call_run.clone());
    }
}

// The ids of the `SendMessage` calls `message` starts. Never held across an await: an async
// body's state holding its closures fails the session task's `Send` proof.
fn message_call_ids(message: &ClaudeMessageFrame) -> impl Iterator<Item = &str> {
    message
        .tool_uses()
        .filter(|(_, tool_name, _)| *tool_name == CLAUDE_MESSAGE_TOOL_NAME)
        .map(|(call_id, ..)| call_id)
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
