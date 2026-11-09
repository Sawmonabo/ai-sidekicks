//! A helper's child run: started when routing reads the helper's start, beneath the run of the
//! helper that launched it unless the daemon refused that run, else the lead run, bound by the
//! agent id its frames and requests carry once the run engine answers, and moved on the helper's
//! own `task_notification`, after which its route retires and its pause or hold is dropped. A
//! helper started again in the same process goes beneath the run that read the `SendMessage` call
//! its start names, else, for a start naming its newest own run's call, beneath that run's parent;
//! a start naming a call not read yet is parked until the call is read, or the helper's next frame
//! or end delivers it beneath the run a first start would take. The same helper keeps its node,
//! and an own run that ended interrupted beneath that same run continues. A helper whose run the
//! daemon refused is bound to that ended run all the same, which absorbs its frames, and is
//! stopped. A helper's new own run clears a stop that is not final. A helper's start and end are
//! also rows on the run its start went beneath. The start is dispatched on the session's task
//! before any later arrival, so a request of the helper finds its run bound. A new child run names
//! the model and effort its `Agent` call asked for, read from the call's pre-tool hook, which
//! Claude Code answers before it runs the call.

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::resumes::{ClaudeHelperResume, ClaudeParkedStart};
use super::{
    ClaudeDeliveryStream, ClaudeSessionStream, UNHELD_FRAME_REASON, bound, record_unmapped,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::system::read_claude_helper_end;
use crate::driver::claude::event_normalizer::ClaudeSubagentLifecycleSignal;
use crate::driver::claude::hooks::callbacks::ClaudeHelperCall;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeChildRunRoute};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::{
    ChildRunSubagent, DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome,
    LateAppendableRow,
};
use crate::run::state_entry::RunStateEntry;
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

impl ClaudeDeliveryStream {
    // A helper's start gets a child run beneath the run of the helper that launched it, else the
    // lead run holding the turn as the frame was read, and both its rows go on that run, naming the
    // helper's child run. A resume goes beneath the run that read its `SendMessage` call, else,
    // when it names the call of the helper's newest own start, beneath that start's parent while
    // it runs; a resume naming a call not read yet is parked, and a start or end of the helper
    // first delivers the one parked. `signal` is the lifecycle signal the frame itself carries.
    pub(super) async fn deliver_helper_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        lead_at_read: Option<ClaudeBoundRun>,
        signal: Option<&ClaudeSubagentLifecycleSignal>,
        emission: SubagentLifecycleEmission,
    ) {
        // A helper id the transcript cannot hold names no helper a row or a node could show.
        let Ok(subagent_id) = SubagentId::new(emission.subagent_id.clone()) else {
            return;
        };
        self.flush_parked_start(session, &emission.subagent_id)
            .await;
        let routes = &self.dependencies.routes;
        let turn_lead = lead_at_read.or_else(|| routes.lead_run_on(session.session_id));
        match emission.event_type {
            SubagentLifecycleEventType::Started => {
                let resume = {
                    let mut readings = session.lock();
                    let continuable_run = readings.continuable_run.map(|(run_id, _)| run_id);
                    readings.helper_resumes.resume_of(
                        routes,
                        continuable_run,
                        &emission.subagent_id,
                        emission.parent_tool_call_id.as_deref(),
                    )
                };
                // It waits for its call, sending nothing yet.
                if resume
                    .as_ref()
                    .is_some_and(|resume| resume.is_awaiting_call)
                {
                    session.lock().helper_resumes.park(ClaudeParkedStart {
                        subagent_id,
                        emission,
                        signal: signal.cloned(),
                        lead_at_read: turn_lead,
                    });
                    return;
                }
                self.start_helper(
                    session,
                    turn_lead.as_ref(),
                    resume.as_ref(),
                    signal,
                    &emission,
                    subagent_id,
                )
                .await;
            }
            SubagentLifecycleEventType::Completed => {
                session.forget_helper_calls_of(&emission.subagent_id);
                session
                    .lock()
                    .helper_tool_calls
                    .end_helper(&emission.subagent_id);
                // An end goes on the run its start went beneath.
                let carrier = self
                    .helper_parent_run(session, &emission.subagent_id)
                    .or_else(|| turn_lead.clone());
                let Some(carrier) = self
                    .open_carrier(session, carrier, turn_lead.as_ref(), emission.event_type)
                    .await
                else {
                    return;
                };
                // A helper's end names the child run its start was given.
                let child_run_id = routes.child_run_for(session.session_id, &emission.subagent_id);
                self.send_lifecycle_row(session, &carrier, &emission, subagent_id, child_run_id)
                    .await;
            }
        }
    }

    // Delivers a helper's start beneath the run its resume names, else its launcher's bound run,
    // else `turn_lead`: an own run that ended interrupted beneath that run continues, else a new
    // child run is asked for; either is bound to the helper, which loses a stop that is not final,
    // recorded as its newest own run and named by the start's row on that run. Answers the child
    // run given and the run it went beneath.
    pub(super) async fn start_helper(
        &self,
        session: &ClaudeSessionStream,
        turn_lead: Option<&ClaudeBoundRun>,
        resume: Option<&ClaudeHelperResume>,
        signal: Option<&ClaudeSubagentLifecycleSignal>,
        emission: &SubagentLifecycleEmission,
        subagent_id: SubagentId,
    ) -> Option<(RunId, ClaudeBoundRun)> {
        let parent_task_id = signal.and_then(|signal| signal.parent_task_id.as_deref());
        // A launcher whose route retired, was never seen or holds a run the daemon refused falls
        // to the lead.
        let carrier = resume
            .and_then(|resume| resume.carrier.clone())
            .or_else(|| parent_task_id.and_then(|parent| self.helper_run(session, parent)))
            .or_else(|| turn_lead.cloned());
        let carrier = self
            .open_carrier(session, carrier, turn_lead, emission.event_type)
            .await?;
        let routes = &self.dependencies.routes;
        let parent_tool_call_id = emission.parent_tool_call_id.as_deref();
        let interrupted_run =
            resume.and_then(|resume| resume.interrupted_run_beneath(carrier.run_id));
        let continued = match interrupted_run {
            Some(run_id) => self.continue_helper_run(session, &carrier, run_id).await,
            None => None,
        };
        let (run_id, refusal) = if let Some(run_id) = continued {
            (Some(run_id), None)
        } else {
            let helper_call =
                parent_tool_call_id.and_then(|call_id| session.lock().helper_calls.remove(call_id));
            let (model_id, effort) =
                helper_call.map_or((None, None), |call| (call.model_id, call.effort));
            let child = InboundDelivery::ChildRun {
                binding: DeliveryBinding {
                    binding_id: carrier.binding_id.clone(),
                    operation: parent_tool_call_id.map(|correlation_key| DeliveryOperation {
                        correlation_key,
                        is_opening: false,
                    }),
                },
                parent_run_id: carrier.run_id,
                subagent: ChildRunSubagent {
                    subagent_id: subagent_id.clone(),
                    // Kept as Claude Code gave it, even for a launcher no route knows.
                    parent_subagent_id: parent_task_id
                        .and_then(|parent| SubagentId::new(parent.to_owned()).ok()),
                    name: None,
                    // A role the contract cannot hold reads as absent.
                    role: signal
                        .and_then(|signal| signal.subagent_type.as_deref())
                        .and_then(|role| FreeFormText::new(role.to_owned()).ok()),
                    provider_path: None,
                    model_id,
                    effort,
                    start_call_id: start_call_of(emission),
                },
            };
            match self.send(session, child, Some("system/task_started")).await {
                Some(InboundOutcome::ChildRunStarted { run_id }) => (Some(run_id), None),
                Some(InboundOutcome::ChildRunRefused { run_id, reason }) => {
                    (Some(run_id), Some(reason))
                }
                Some(
                    InboundOutcome::TurnOpened
                    | InboundOutcome::Transitioned { .. }
                    | InboundOutcome::Published
                    | InboundOutcome::AskAdmitted
                    | InboundOutcome::Appended { .. }
                    | InboundOutcome::AppendedStamped { .. }
                    | InboundOutcome::Absorbed { .. }
                    | InboundOutcome::NotSentByPerson,
                )
                | None => (None, None),
            }
        };
        if let Some(run_id) = run_id {
            routes.bind_child_run(
                run_id,
                ClaudeChildRunRoute {
                    session_id: session.session_id,
                    agent_id: emission.subagent_id.clone(),
                    parent_run_id: carrier.run_id,
                    binding_id: carrier.binding_id.clone(),
                    is_refused: refusal.is_some(),
                },
            );
            // Its new own run clears a stop that is not final; refused again, it is stopped
            // again below.
            lock(&self.dependencies.pauses)
                .release_helper(session.session_id, &emission.subagent_id);
            session.lock().helper_resumes.record_start(
                &emission.subagent_id,
                parent_tool_call_id,
                run_id,
                carrier.clone(),
            );
        }
        // A refused helper still runs in Claude Code: its next tool use is denied, so it reports
        // and finishes while the lead's turn goes on.
        if let Some(refusal) = refusal {
            lock(&self.dependencies.pauses).stop_helper(
                session.session_id,
                &emission.subagent_id,
                HelperStopReason::SetupRefused { refusal },
            );
        }
        let child_run_id =
            run_id.or_else(|| routes.child_run_for(session.session_id, &emission.subagent_id));
        self.send_lifecycle_row(session, &carrier, emission, subagent_id, child_run_id)
            .await;
        run_id.map(|run_id| (run_id, carrier))
    }

    // A helper's child run moves on its own `task_notification`, read with why the daemon stopped
    // the helper, then its route retires. The end is the daemon's own where the person stopped the
    // helper from the console or a pause or an interrupt holds it, so an end landing on a run
    // already interrupted is no late event. A start of the helper still parked is delivered first.
    pub(super) async fn end_helper(&self, session: &ClaudeSessionStream, task: &ClaudeTaskFrame) {
        let Some(task_id) = task.task_id() else {
            return;
        };
        self.flush_parked_start(session, task_id).await;
        let routes = &self.dependencies.routes;
        let Some((child_run_id, route)) = routes.child_route_for(session.session_id, task_id)
        else {
            return;
        };
        let (stop, is_held) = {
            let pauses = lock(&self.dependencies.pauses);
            (
                pauses.helper_stop_reason(&session.session_id, &route.agent_id),
                pauses.is_helper_held(&session.session_id, &route.agent_id),
            )
        };
        let is_daemon_interrupt_end = matches!(stop, Some(HelperStopReason::StopAll)) || is_held;
        let Some(change) = read_claude_helper_end(task, child_run_id, stop.as_ref()) else {
            return;
        };
        // A refused run ended failed at its setup, whatever Claude Code reports of the helper.
        let is_interrupted =
            !route.is_refused && matches!(change.entry, RunStateEntry::Interrupted { .. });
        let delivery = InboundDelivery::RunLifecycle {
            binding: bound(&ClaudeBoundRun {
                run_id: child_run_id,
                binding_id: route.binding_id,
            }),
            change,
            turn_end: None,
            is_daemon_interrupt_end,
        };
        self.send(session, delivery, Some("system/task_notification"))
            .await;
        session
            .lock()
            .helper_resumes
            .record_end(&route.agent_id, child_run_id, is_interrupted);
        // A pause or an interrupt's hold ends with the run, so the helper's next own run is not
        // held unreported; an ended helper holds no call, so none is answered.
        lock(&self.dependencies.pauses).resume_helper(&session.session_id, &route.agent_id, None);
        routes.retire_child_run(child_run_id);
    }

    // The child run of the helper `agent_id` with its binding, while it is bound and the daemon did
    // not refuse it.
    pub(super) fn helper_run(
        &self,
        session: &ClaudeSessionStream,
        agent_id: &str,
    ) -> Option<ClaudeBoundRun> {
        self.dependencies
            .routes
            .child_route_for(session.session_id, agent_id)
            .filter(|(_, route)| !route.is_refused)
            .map(|(run_id, route)| ClaudeBoundRun {
                run_id,
                binding_id: route.binding_id,
            })
    }

    // The run the helper `agent_id` was started beneath, while its child run is bound.
    fn helper_parent_run(
        &self,
        session: &ClaudeSessionStream,
        agent_id: &str,
    ) -> Option<ClaudeBoundRun> {
        let (_, route) = self
            .dependencies
            .routes
            .child_route_for(session.session_id, agent_id)?;
        Some(ClaudeBoundRun {
            run_id: route.parent_run_id,
            binding_id: route.binding_id,
        })
    }

    // The run a helper's start or end of `event_type` goes on, with the lead's turn opened first:
    // a helper's start can be its turn's first frame, which opens the turn before its rows, and a
    // background helper's start or end after its turn ended opens none. With no run, the frame is
    // recorded as held by none.
    async fn open_carrier(
        &self,
        session: &ClaudeSessionStream,
        carrier: Option<ClaudeBoundRun>,
        turn_lead: Option<&ClaudeBoundRun>,
        event_type: SubagentLifecycleEventType,
    ) -> Option<ClaudeBoundRun> {
        let Some(carrier) = carrier else {
            record_unmapped(
                session,
                &session.unheld_reports,
                lifecycle_wire_type(event_type),
                UNHELD_FRAME_REASON,
            );
            return None;
        };
        if let Some(turn_lead) = turn_lead {
            self.open_turn(session, turn_lead).await;
        }
        Some(carrier)
    }

    // The helper's start or end row on `carrier`, naming its child run.
    async fn send_lifecycle_row(
        &self,
        session: &ClaudeSessionStream,
        carrier: &ClaudeBoundRun,
        emission: &SubagentLifecycleEmission,
        subagent_id: SubagentId,
        child_run_id: Option<RunId>,
    ) {
        let payload = SubagentLifecyclePayload {
            session_id: session.session_id,
            run_id: carrier.run_id,
            provider: DESCRIPTOR.provider_id(),
            subagent_id,
            child_run_id,
            parent_tool_call_id: start_call_of(emission),
            source_epoch: None,
            source_position: None,
        };
        let row = match emission.event_type {
            SubagentLifecycleEventType::Started => LateAppendableRow::AgentSubagentStarted(payload),
            SubagentLifecycleEventType::Completed => {
                LateAppendableRow::AgentSubagentCompleted(payload)
            }
        };
        self.send_row(
            session,
            carrier,
            row,
            lifecycle_wire_type(emission.event_type),
        )
        .await;
    }
}

impl ClaudeSessionStream {
    /// Keeps what the helper call `helper_call` asked for until its helper's start takes it, or
    /// its caller's turn ends with no start: the lead's at its turn-ending `result`, a helper's at
    /// its own end.
    pub(crate) fn record_helper_call(&self, helper_call: ClaudeHelperCall) {
        self.lock()
            .helper_calls
            .insert(helper_call.call_id.clone(), helper_call);
    }

    /// Forgets the helper call `call_id`, which starts no helper: it failed before any started, or
    /// Claude Code withdrew the helper limit's hold on it.
    pub(crate) fn forget_helper_call(&self, call_id: &str) {
        self.lock().helper_calls.remove(call_id);
    }

    /// Forgets the helper call whose pre-tool hook the request `request_id` carried, once Claude
    /// Code withdraws it or a held call is released with a deny: neither starts a helper.
    pub(crate) fn forget_helper_call_of_request(&self, request_id: &str) {
        self.lock()
            .helper_calls
            .retain(|_, helper_call| helper_call.request_id != request_id);
    }

    /// Forgets every helper call of the lead's that no start took by its turn's end: Claude Code
    /// starts a call's helper before the call answers, so the call was denied or interrupted.
    pub(crate) fn forget_lead_helper_calls(&self) {
        self.lock()
            .helper_calls
            .retain(|_, helper_call| helper_call.caller_agent_id.is_some());
    }

    // Forgets every helper call of the helper `agent_id` that no start took by its end, as the
    // lead's are at its turn's end.
    fn forget_helper_calls_of(&self, agent_id: &str) {
        self.lock()
            .helper_calls
            .retain(|_, helper_call| helper_call.caller_agent_id.as_deref() != Some(agent_id));
    }
}

// The call a helper's start or end names, where the contract can hold it.
fn start_call_of(emission: &SubagentLifecycleEmission) -> Option<ToolCallId> {
    emission
        .parent_tool_call_id
        .as_deref()
        .and_then(|call| ToolCallId::new(call.to_owned()).ok())
}

fn lifecycle_wire_type(event_type: SubagentLifecycleEventType) -> &'static str {
    match event_type {
        SubagentLifecycleEventType::Started => "system/task_started",
        SubagentLifecycleEventType::Completed => "system/task_notification",
    }
}

#[cfg(test)]
pub(super) mod tests;
