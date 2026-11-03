//! The person's verdict on a held plan, written as the answer to the request Claude Code holds
//! open for it: keep and hand-off refuse it with the keep sentence, and build allows it with one
//! move of the session to the build level's own permission mode.

use serde_json::{Value, json};

use super::PLAN_KEPT_REASON;
use crate::driver::claude::delivery::requests::{
    ClaudeInboundRequests, ClaudeRequestAnswerError, write_answer,
};
use crate::driver::claude::session::permission_level::claude_permission_mode_for;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::plan_verdict::PlanVerdict;

impl ClaudeInboundRequests {
    /// Answers the plan request `request_id`, recorded as `admission`, with `verdict` and closes
    /// that recording. Fails as the answer's write fails, the recording then staying open unless
    /// the write was cut short.
    pub(crate) async fn answer_held_plan(
        &self,
        live: &LiveClaudeSession,
        request_id: &str,
        admission: u64,
        verdict: PlanVerdict,
    ) -> Result<(), ClaudeRequestAnswerError> {
        write_answer(
            &self.tables,
            &*live.channel,
            live.session_id,
            request_id,
            admission,
            &compose_plan_verdict_answer(verdict),
        )
        .await
    }
}

// The answer Claude Code reads for `verdict`.
fn compose_plan_verdict_answer(verdict: PlanVerdict) -> Value {
    match verdict {
        PlanVerdict::Keep {} | PlanVerdict::HandOff {} => {
            json!({"behavior": "deny", "message": PLAN_KEPT_REASON})
        }
        PlanVerdict::Build { level } => json!({
            "behavior": "allow",
            "updatedPermissions": [{
                "type": "setMode",
                "mode": claude_permission_mode_for(Some(level)),
                "destination": "session",
            }],
        }),
    }
}
