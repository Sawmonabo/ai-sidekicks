//! A helper's child run: started when routing reads the helper's start, beneath the run of the
//! helper that launched it, else the lead run, bound by the agent id its frames and requests carry
//! once the run engine answers, and moved on the helper's own `task_notification`, after which its
//! route retires. A helper whose run the daemon refused is bound to that ended run all the same,
//! which absorbs its frames, and is stopped. A helper's start and end are also rows on the run its
//! start went beneath. The start is dispatched on the session's task before any later arrival, so a
//! request of the helper finds its run bound.

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeDeliveryStream, ClaudeSessionStream, UNHELD_FRAME_REASON, bound, record_unmapped,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::requests::attribute_claude_request;
use crate::driver::claude::delivery::system::read_claude_helper_end;
use crate::driver::claude::event_normalizer::ClaudeSubagentLifecycleSignal;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeChildRunRoute, ClaudeRunRoute};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::{
    ChildRunSubagent, DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome,
    LateAppendableRow,
};
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

impl ClaudeDeliveryStream {
    // A helper's start gets a child run beneath the run of the helper that launched it, else the
    // lead run holding the turn as the frame was read, and both its rows go on that run, naming the
    // helper's child run. `signal` is the lifecycle signal the frame itself carries.
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
        let routes = &self.dependencies.routes;
        let turn_lead = lead_at_read.or_else(|| routes.lead_run_on(session.session_id));
        let parent_task_id = signal.and_then(|signal| signal.parent_task_id.as_deref());
        // A start hangs under its launcher's bound run, and a launcher whose route retired or was
        // never seen falls to the lead; an end goes on the run its start went beneath.
        let carrier = match emission.event_type {
            SubagentLifecycleEventType::Started => parent_task_id
                .and_then(|parent| {
                    attribute_claude_request(routes, session.session_id, Some(parent))
                })
                .or_else(|| turn_lead.clone()),
            SubagentLifecycleEventType::Completed => self
                .helper_parent_run(session, &emission.subagent_id)
                .or_else(|| turn_lead.clone()),
        };
        let Some(carrier) = carrier else {
            record_unmapped(
                session,
                &session.unheld_reports,
                lifecycle_wire_type(emission.event_type),
                UNHELD_FRAME_REASON,
            );
            return;
        };
        // A helper's start can be its turn's first frame, which opens the lead's turn before its
        // rows; a background helper's start or end after its turn ended opens none.
        if let Some(turn_lead) = &turn_lead {
            self.open_turn(session, turn_lead).await;
        }
        let parent_tool_call_id = emission.parent_tool_call_id.as_deref();
        let tool_call_id =
            parent_tool_call_id.and_then(|call| ToolCallId::new(call.to_owned()).ok());
        let mut child_run_id = None;
        if emission.event_type == SubagentLifecycleEventType::Started {
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
                    start_call_id: tool_call_id.clone(),
                },
            };
            let (run_id, refusal) =
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
                        | InboundOutcome::Absorbed { .. },
                    )
                    | None => (None, None),
                };
            if let Some(run_id) = run_id {
                child_run_id = Some(run_id);
                routes.bind_child_run(
                    run_id,
                    ClaudeChildRunRoute {
                        session_id: session.session_id,
                        agent_id: emission.subagent_id.clone(),
                        parent_run_id: carrier.run_id,
                        binding_id: carrier.binding_id.clone(),
                    },
                );
            }
            // A refused helper still runs in Claude Code: its next tool use is denied, so it
            // reports and finishes while the lead's turn goes on.
            if let Some(refusal) = refusal {
                lock(&self.dependencies.pauses).stop_helper(
                    session.session_id,
                    &emission.subagent_id,
                    HelperStopReason::SetupRefused { refusal },
                );
            }
        }
        // A helper's end names the child run its start was given.
        let child_run_id = child_run_id
            .or_else(|| routes.child_run_for(session.session_id, &emission.subagent_id));
        let payload = SubagentLifecyclePayload {
            session_id: session.session_id,
            run_id: carrier.run_id,
            provider: DESCRIPTOR.provider_id(),
            subagent_id,
            child_run_id,
            parent_tool_call_id: tool_call_id,
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
            &carrier,
            row,
            lifecycle_wire_type(emission.event_type),
        )
        .await;
    }

    // A helper's child run moves on its own `task_notification`, then its route retires.
    pub(super) async fn end_helper(&self, session: &ClaudeSessionStream, task: &ClaudeTaskFrame) {
        let routes = &self.dependencies.routes;
        let Some(child_run_id) = task
            .task_id()
            .and_then(|task_id| routes.child_run_for(session.session_id, task_id))
        else {
            return;
        };
        let Some(ClaudeRunRoute::Child(route)) = routes.route_of(child_run_id) else {
            return;
        };
        let Some(change) = read_claude_helper_end(task, child_run_id) else {
            return;
        };
        let delivery = InboundDelivery::RunLifecycle {
            binding: bound(&ClaudeBoundRun {
                run_id: child_run_id,
                binding_id: route.binding_id,
            }),
            change,
            turn_end: None,
            is_daemon_interrupt_end: false,
        };
        self.send(session, delivery, Some("system/task_notification"))
            .await;
        routes.retire_child_run(child_run_id);
    }

    // The run the helper `agent_id` was started beneath, while its child run is bound.
    fn helper_parent_run(
        &self,
        session: &ClaudeSessionStream,
        agent_id: &str,
    ) -> Option<ClaudeBoundRun> {
        let routes = &self.dependencies.routes;
        let child_run_id = routes.child_run_for(session.session_id, agent_id)?;
        let Some(ClaudeRunRoute::Child(route)) = routes.route_of(child_run_id) else {
            return None;
        };
        Some(ClaudeBoundRun {
            run_id: route.parent_run_id,
            binding_id: route.binding_id,
        })
    }
}

fn lifecycle_wire_type(event_type: SubagentLifecycleEventType) -> &'static str {
    match event_type {
        SubagentLifecycleEventType::Started => "system/task_started",
        SubagentLifecycleEventType::Completed => "system/task_notification",
    }
}

#[cfg(test)]
mod tests;
