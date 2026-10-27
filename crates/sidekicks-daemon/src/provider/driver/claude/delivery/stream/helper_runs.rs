//! A helper's child run: started beneath the lead run when routing reads the helper's start, bound
//! by the agent id its frames and requests carry once the run engine answers, and moved on the
//! helper's own `task_notification`, after which its route retires. A helper's start and end are
//! also rows on the lead run. The start is dispatched on the session's task before any later
//! arrival, so a request of the helper finds its run bound.

use serde_json::{Map, Value};
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::subagent::SubagentLifecyclePayload;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    ClaudeDeliveryStream, ClaudeSessionStream, UNHELD_FRAME_REASON, bound, record_unmapped,
};
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::system::read_claude_helper_end;
use crate::provider::driver::claude::run::routes::{
    ClaudeBoundRun, ClaudeChildRunRoute, ClaudeRunRoute,
};
use crate::provider::record_readers::read_non_empty_string;
use crate::provider::run::delivery::{
    DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome, LateAppendableRow,
};
use crate::provider::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

impl ClaudeDeliveryStream {
    // A helper's start gets a child run beneath the lead run, the one holding the turn as the
    // frame was read, and both ends get their row on it.
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
            if let Some(InboundOutcome::ChildRunStarted { run_id }) =
                self.send(session, child, Some("system/task_started")).await
            {
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
        }
        let Ok(subagent_id) = FreeFormText::new(emission.subagent_id.clone()) else {
            return;
        };
        let payload = SubagentLifecyclePayload {
            session_id: session.session_id,
            run_id: lead.run_id,
            provider: DESCRIPTOR.provider_id(),
            subagent_id,
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
    pub(super) async fn end_helper(
        &self,
        session: &ClaudeSessionStream,
        members: &Map<String, Value>,
    ) {
        let routes = &self.dependencies.routes;
        let Some(child_run_id) = read_non_empty_string(members, "task_id")
            .and_then(|task_id| routes.child_run_for(session.session_id, task_id))
        else {
            return;
        };
        let Some(ClaudeRunRoute::Child(route)) = routes.route_of(child_run_id) else {
            return;
        };
        let Some(change) = read_claude_helper_end(members, child_run_id) else {
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
