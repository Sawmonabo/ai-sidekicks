//! The plan Claude Code proposes as it asks to leave plan mode, held for the person's verdict: its
//! request is admitted under its own id like a question, the plan handed to the plan record on a
//! task of its own under the id minted here, and the request kept open until a verdict answers it
//! or Claude Code withdraws it. A withdrawal while the record is written is reported once it is.

use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::pending::HeldRequest;
use super::{ClaudeInboundRequests, ClaudeRequestSession, record_hand_off_failure};
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::port::plan::{ProviderPlan, ProviderPlanHoldEnd, mint_plan_id};
use crate::record_readers::read_non_empty_string;

impl ClaudeInboundRequests {
    /// The request the session holds open for the plan `plan_id`, from the moment it is admitted.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the plan verdict answers the request it finds here"
        )
    )]
    pub(crate) fn held_plan_request(
        &self,
        session_id: SessionId,
        plan_id: PlanId,
    ) -> Option<String> {
        self.lock()
            .held_plan(session_id, plan_id)
            .map(str::to_owned)
    }

    // Holds the plan the request carries, Claude Code's `plan` text and the plan file it wrote
    // beside it, under a plan id minted before the take, so a verdict finds it once admitted. Left
    // held when it carries no plan text or no plan record is registered.
    pub(super) async fn hold_plan(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: String,
        run: &ClaudeBoundRun,
        tool_call_id: Option<&str>,
        input: Map<String, Value>,
    ) {
        let session_id = session.stream.session_id();
        let plan_id = mint_plan_id();
        let held = HeldRequest::Plan { plan_id };
        let wire = "control_request/can_use_tool";
        let Some((admitted, admission, _let_go)) = self
            .admit(session, &request_id, run, tool_call_id, held, wire)
            .await
        else {
            return;
        };
        let Some(text) = input
            .get("plan")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        else {
            return;
        };
        let Some(port) = self.dependencies.plans.port().cloned() else {
            return;
        };
        let plan = ProviderPlan {
            plan_id,
            session_id,
            run_id: run.run_id,
            text: text.to_owned(),
            plan_file_path: read_non_empty_string(&input, "planFilePath")
                .and_then(|path| FilesystemPath::new(path.to_owned()).ok()),
            holds_request: true,
        };
        let tables = Arc::clone(&self.tables);
        tokio::spawn(async move {
            let taken = port.take_plan(plan).await;
            if let Err(error) = &taken {
                record_hand_off_failure(session_id, admitted, error.as_ref());
            }
            // Claude Code's withdrawal while the record was written is reported now that it is;
            // a plan that was never recorded has no hold to end.
            let is_withdrawn =
                lock(&tables).end_plan_take(session_id, &request_id, admission, taken.is_ok());
            if !is_withdrawn || taken.is_err() {
                return;
            }
            if let Err(error) = port
                .end_plan_hold(withdrawn_hold_end(session_id, plan_id))
                .await
            {
                record_hand_off_failure(session_id, admitted, error.as_ref());
            }
        });
    }
}

/// The end of the hold on the plan `plan_id` whose request Claude Code withdrew.
pub(super) fn withdrawn_hold_end(session_id: SessionId, plan_id: PlanId) -> ProviderPlanHoldEnd {
    ProviderPlanHoldEnd {
        session_id,
        plan_id,
        reason: PlanHoldEndedReason::Withdrawn,
    }
}

#[cfg(test)]
mod tests;
