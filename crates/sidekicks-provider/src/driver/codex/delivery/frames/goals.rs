//! Codex's reports of a change to the goal of the session's own conversation, the daemon's own set
//! and clear among them, as the goal row of the session's lead agent: an update draws the goal at
//! its status, a clear draws the clear, except while the driver replaces the goal, whose clear and
//! interim updates fold into the row of the goal the replace answered. A helper's goal draws no
//! row until the agent tree names helpers; it and a report this reader cannot place are logged and
//! dropped.

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
        let run_routes = &self.dependencies.run_routes;
        let is_own_thread = thread_id == Some(record.thread_id.as_str());
        let is_cleared = method == CODEX_GOAL_CLEARED_METHOD;
        if is_own_thread && let Some(replace) = run_routes.goal_replace(record.session_id) {
            // The replace's clear and its updates before the awaited one: the awaited goal's row
            // stands for them all.
            if is_cleared {
                return;
            }
            let goal = members.get("goal");
            if replace.awaited_goal.is_some() && goal == replace.awaited_goal.as_ref() {
                run_routes.end_goal_replace(record.session_id);
                if !replace.is_drawn {
                    return;
                }
            } else if read_goal_objective(members).is_some_and(|objective| {
                replace
                    .absorbed_objectives
                    .iter()
                    .any(|absorbed| absorbed == objective)
            }) {
                return;
            }
        }
        let row = if !is_own_thread {
            Err(CodexGoalDropReason::OtherThread)
        } else if is_cleared {
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

// The objective of a `thread/goal/updated` frame's goal.
fn read_goal_objective(members: &Map<String, Value>) -> Option<&str> {
    members
        .get("goal")
        .and_then(Value::as_object)
        .and_then(|goal| read_non_empty_string(goal, "objective"))
}

// The lead's goal at the status a `thread/goal/updated` frame's goal names. Codex's goal carries
// no reason, and Codex never rules a goal impossible.
fn read_goal_update(
    record: &CodexSessionRecord,
    members: &Map<String, Value>,
) -> Result<SessionGoalUpdatedPayload, CodexGoalDropReason> {
    let goal = members.get("goal").and_then(Value::as_object);
    let text = read_goal_objective(members)
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
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::{Map, Value, json};

    use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};

    // The goal Codex reports on `thread/goal/updated`, at `status`.
    fn reported_goal(status: &str) -> Value {
        json!({
            "threadId": TEST_THREAD,
            "objective": "Ship the release notes",
            "status": status,
            "tokensUsed": 120,
            "timeUsedSeconds": 4,
            "createdAt": 1_700_000_000,
            "updatedAt": 1_700_000_004,
        })
    }

    // Codex's goal rows: an update draws the lead's goal at the status Codex names, one to one and
    // with no reason; a clear draws the clear; a status none of the protocol's words draws nothing.
    // Kills: a status mapped to the wrong word, a clear read as an update, an unknown word read as
    // active.
    #[rstest]
    #[case::active("thread/goal/updated", Some("active"), Some("active"))]
    #[case::paused("thread/goal/updated", Some("paused"), Some("paused"))]
    #[case::blocked("thread/goal/updated", Some("blocked"), Some("blocked"))]
    #[case::usage_limited("thread/goal/updated", Some("usageLimited"), Some("usageLimited"))]
    #[case::budget_limited("thread/goal/updated", Some("budgetLimited"), Some("budgetLimited"))]
    #[case::complete("thread/goal/updated", Some("complete"), Some("complete"))]
    #[case::unknown_status("thread/goal/updated", Some("abandoned"), None)]
    #[case::cleared("thread/goal/cleared", None, None)]
    #[tokio::test]
    async fn each_codex_goal_notification_draws_its_goal_row(
        #[case] method: &str,
        #[case] reported_status: Option<&str>,
        #[case] drawn_status: Option<&str>,
    ) {
        let mut session = TestCodexSession::start().await;
        let session_id =
            serde_json::to_value(session.task.record.session_id).expect("an id serializes");
        let agent_id =
            serde_json::to_value(session.task.record.lead_agent_id).expect("an id serializes");
        let params = match reported_status {
            Some(status) => json!({"threadId": TEST_THREAD, "goal": reported_goal(status)}),
            None => json!({"threadId": TEST_THREAD}),
        };
        session
            .scripted
            .script
            .send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
        session.task.handle_next().await;

        let expected = match (method, drawn_status) {
            ("thread/goal/cleared", _) => {
                vec![json!({"sessionId": session_id, "agentId": agent_id})]
            }
            (_, Some(status)) => vec![json!({
                "sessionId": session_id,
                "agentId": agent_id,
                "goal": {"text": "Ship the release notes"},
                "status": status,
            })],
            (_, None) => Vec::new(),
        };
        assert_eq!(session.session_event_payloads(), expected);
    }

    // A goal on a conversation other than the session's own, a helper's, draws no row for the lead,
    // while the same goal on the session's own conversation does. Kill: the thread check removed.
    #[tokio::test]
    async fn a_goal_notification_for_another_conversation_draws_nothing() {
        let session = TestCodexSession::start().await;
        let delivery = Arc::clone(&session.task.calls.forks.delivery);
        let members = |thread_id: &str| -> Map<String, Value> {
            let frame = json!({"threadId": thread_id, "goal": reported_goal("active")});
            frame.as_object().cloned().expect("the frame is an object")
        };

        delivery
            .deliver_goal(
                &session.task.record,
                "thread/goal/updated",
                &members("helper-thread"),
            )
            .await;
        assert_eq!(session.session_event_payloads(), Vec::<Value>::new());

        delivery
            .deliver_goal(
                &session.task.record,
                "thread/goal/updated",
                &members(TEST_THREAD),
            )
            .await;
        assert_eq!(session.session_event_payloads().len(), 1);
    }
}
