//! A helper's child run: started beneath the lead run when routing reads the helper's start, bound
//! by the agent id its frames and requests carry once the run engine answers, and moved on the
//! helper's own `task_notification`, after which its route retires. A helper whose run the daemon
//! refused is bound to that ended run all the same, which absorbs its frames, and is stopped. A
//! helper's start and end are also rows on the lead run. The start is dispatched on the session's
//! task before any later arrival, so a request of the helper finds its run bound.

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeDeliveryStream, ClaudeSessionStream, UNHELD_FRAME_REASON, bound, record_unmapped,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::system::read_claude_helper_end;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeChildRunRoute, ClaudeRunRoute};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::{
    DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome, LateAppendableRow,
};
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

impl ClaudeDeliveryStream {
    // A helper's start gets a child run beneath the lead run, the one holding the turn as the
    // frame was read, and both ends get their row on it, naming the helper's child run.
    pub(super) async fn deliver_helper_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        lead_at_read: Option<ClaudeBoundRun>,
        emission: SubagentLifecycleEmission,
    ) {
        let routes = &self.dependencies.routes;
        let lead = lead_at_read.or_else(|| routes.lead_run_on(session.session_id));
        let is_lead_turn = lead.is_some();
        let Some(lead) = lead.or_else(|| self.helper_parent_run(session, &emission)) else {
            record_unmapped(
                session,
                &session.unheld_reports,
                lifecycle_wire_type(emission.event_type),
                UNHELD_FRAME_REASON,
            );
            return;
        };
        // A helper's start can be its turn's first frame, which opens the turn before its rows; a
        // background helper's end after its turn ended opens none.
        if is_lead_turn {
            self.open_turn(session, &lead).await;
        }
        let parent_tool_call_id = emission.parent_tool_call_id.as_deref();
        let mut child_run_id = None;
        if emission.event_type == SubagentLifecycleEventType::Started {
            let child = InboundDelivery::ChildRun {
                binding: DeliveryBinding {
                    binding_id: lead.binding_id.clone(),
                    operation: parent_tool_call_id.map(|correlation_key| DeliveryOperation {
                        correlation_key,
                        is_opening: false,
                    }),
                },
                parent_run_id: lead.run_id,
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
                        parent_run_id: lead.run_id,
                        binding_id: lead.binding_id.clone(),
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
        let Ok(subagent_id) = SubagentId::new(emission.subagent_id.clone()) else {
            return;
        };
        let payload = SubagentLifecyclePayload {
            session_id: session.session_id,
            run_id: lead.run_id,
            provider: DESCRIPTOR.provider_id(),
            subagent_id,
            child_run_id,
            parent_tool_call_id: emission
                .parent_tool_call_id
                .and_then(|tool_call_id| ToolCallId::new(tool_call_id).ok()),
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
            &lead,
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

    // The lead run a helper was started beneath, for a background helper whose turn already ended.
    fn helper_parent_run(
        &self,
        session: &ClaudeSessionStream,
        emission: &SubagentLifecycleEmission,
    ) -> Option<ClaudeBoundRun> {
        if emission.event_type != SubagentLifecycleEventType::Completed {
            return None;
        }
        let routes = &self.dependencies.routes;
        let child_run_id = routes.child_run_for(session.session_id, &emission.subagent_id)?;
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
