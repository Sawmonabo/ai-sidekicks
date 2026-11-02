//! Codex's reports of a change to the goal of the session's own conversation, the daemon's own set
//! and clear among them, as the goal row of the session's lead agent: an update draws the goal at
//! its status, a clear draws the clear. A helper's goal draws no row until the agent tree names
//! helpers; it and a report this reader cannot place are logged and dropped.

use serde_json::{Map, Value};
use sidekicks_contracts::session::goal::{
    SessionGoal, SessionGoalClearedPayload, SessionGoalStatus, SessionGoalUpdatedPayload,
};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::app_server_protocol::ThreadGoalStatus;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::diagnostics::{CodexGoalDropReason, CodexTransportDiagnostic};
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::{InboundDelivery, SessionScopedRow};

// The notification Codex sends once a conversation's goal is cleared.
const CODEX_GOAL_CLEARED_METHOD: &str = "thread/goal/cleared";

impl CodexFrameDelivery {
    /// Appends the goal row a `thread/goal/updated` or `thread/goal/cleared` frame draws.
    pub(super) async fn deliver_goal(
        &self,
        record: &CodexSessionRecord,
        method: &str,
        members: &Map<String, Value>,
    ) {
        let thread_id = read_non_empty_string(members, "threadId");
        let row = if thread_id != Some(record.thread_id.as_str()) {
            Err(CodexGoalDropReason::OtherThread)
        } else if method == CODEX_GOAL_CLEARED_METHOD {
            Ok(SessionScopedRow::GoalCleared(SessionGoalClearedPayload {
                session_id: record.session_id,
                agent_id: record.lead_agent_id,
            }))
        } else {
            read_goal_update(record, members).map(SessionScopedRow::GoalUpdated)
        };
        match row {
            Ok(row) => {
                self.send(record, InboundDelivery::SessionEvent { row }, method)
                    .await;
            }
            Err(reason) => CodexTransportDiagnostic::GoalNotificationDropped {
                method: method.to_owned(),
                session_id: record.session_id,
                thread_id: thread_id.map(str::to_owned),
                reason,
            }
            .report(),
        }
    }
}

// The lead's goal at the status a `thread/goal/updated` frame's goal names. Codex's goal carries
// no reason, and Codex never rules a goal impossible.
fn read_goal_update(
    record: &CodexSessionRecord,
    members: &Map<String, Value>,
) -> Result<SessionGoalUpdatedPayload, CodexGoalDropReason> {
    let goal = members.get("goal").and_then(Value::as_object);
    let text = goal
        .and_then(|goal| read_non_empty_string(goal, "objective"))
        .and_then(|objective| FreeFormText::new(objective.to_owned()).ok())
        .ok_or(CodexGoalDropReason::NoObjective)?;
    let status = goal
        .and_then(|goal| read_non_empty_string(goal, "status"))
        .and_then(|status| status.parse::<ThreadGoalStatus>().ok())
        .ok_or(CodexGoalDropReason::UnknownStatus)?;
    Ok(SessionGoalUpdatedPayload {
        session_id: record.session_id,
        agent_id: record.lead_agent_id,
        goal: SessionGoal { text },
        status: session_goal_status(status),
        reason: None,
    })
}

fn session_goal_status(status: ThreadGoalStatus) -> SessionGoalStatus {
    match status {
        ThreadGoalStatus::Active => SessionGoalStatus::Active,
        ThreadGoalStatus::Paused => SessionGoalStatus::Paused,
        ThreadGoalStatus::Blocked => SessionGoalStatus::Blocked,
        ThreadGoalStatus::UsageLimited => SessionGoalStatus::UsageLimited,
        ThreadGoalStatus::BudgetLimited => SessionGoalStatus::BudgetLimited,
        ThreadGoalStatus::Complete => SessionGoalStatus::Complete,
    }
}

#[cfg(test)]
mod tests;
