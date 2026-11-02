//! The plan Claude Code proposes as it asks to leave plan mode, held for the person's verdict: its
//! request is admitted under its own id like a question, the plan handed to the plan record on a
//! task of its own under the id minted here, and the request kept open until a verdict answers it
//! or Claude Code withdraws it. A withdrawal while the record is written is reported once it is. A
//! plan that cannot be recorded is refused at once, and once a newer plan is recorded the held
//! requests of the older plans its record set aside are answered to wait for the person.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::pending::{HeldRequest, RequestTables};
use super::{
    ClaudeInboundRequests, ClaudeRequestSession, close_recording, record_hand_off_failure,
    write_answer,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::plan::{ProviderPlan, ProviderPlanHoldEnd, mint_plan_id};
use crate::record_readers::read_non_empty_string;

// The wire a plan request arrives on.
const PLAN_REQUEST_WIRE: &str = "control_request/can_use_tool";

// Why a plan that could not be put to the person is refused, which the agent reads in place of a
// verdict.
const PLAN_UNSHOWN_REASON: &str =
    "The plan could not be put to the person, so it was not answered.";

// What a plan the person is still reviewing is answered, so the agent stays in plan mode and waits.
const PLAN_KEPT_REASON: &str =
    "The person is still reviewing the plan. Stop and wait for their next message.";

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
            .map(|(request_id, _admission)| request_id.to_owned())
    }

    // Holds the plan the request carries, Claude Code's `plan` text and the plan file it wrote
    // beside it, under a plan id minted before the take, so a verdict finds it once admitted. One
    // with no plan text, no plan record registered or a take that fails is refused, unless Claude
    // Code let it go meanwhile; once the take returns, the held requests of the plans its record
    // set aside are answered to wait, since the newer one stands in their place.
    pub(super) async fn hold_plan(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: String,
        run: &ClaudeBoundRun,
        tool_call_id: Option<&str>,
        input: Map<String, Value>,
    ) {
        let session_id = session.stream.session_id();
        let account_id = session.stream.provider_account_id().clone();
        let plan_id = mint_plan_id();
        let held = HeldRequest::Plan { plan_id };
        let Some((admitted, admission, _let_go)) = self
            .admit(
                session,
                &request_id,
                run,
                tool_call_id,
                held,
                PLAN_REQUEST_WIRE,
            )
            .await
        else {
            return;
        };
        let text = input
            .get("plan")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty());
        let (Some(text), Some(port)) = (text, self.dependencies.plans.port().cloned()) else {
            let cause = if text.is_none() {
                "the request carried no plan text"
            } else {
                "no plan record is registered"
            };
            // The take that never starts ends here, so the session keeps no mark of it.
            self.lock()
                .end_plan_take(session_id, &request_id, admission, false);
            record_plan_not_recorded(session_id, &account_id, &request_id, cause.to_owned());
            deny_plan_request(
                &self.tables,
                &*session.channel,
                session_id,
                &request_id,
                admission,
                PLAN_UNSHOWN_REASON,
            )
            .await;
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
        let (tables, channel) = (Arc::clone(&self.tables), Arc::clone(&session.channel));
        tokio::spawn(async move {
            let taken = port.take_plan(plan).await;
            let (is_withdrawn, is_held, set_aside) = {
                let mut tables = lock(&tables);
                let is_withdrawn =
                    tables.end_plan_take(session_id, &request_id, admission, taken.is_ok());
                let is_held = tables.is_pending(session_id, &request_id, admission);
                let set_aside: Vec<(String, u64)> = match &taken {
                    Ok(superseded) => superseded
                        .iter()
                        .filter_map(|&older| tables.held_plan(session_id, older))
                        .map(|(older_request_id, older_admission)| {
                            (older_request_id.to_owned(), older_admission)
                        })
                        .collect(),
                    Err(_) => Vec::new(),
                };
                (is_withdrawn, is_held, set_aside)
            };
            if let Err(error) = taken {
                record_plan_not_recorded(
                    session_id,
                    &account_id,
                    &request_id,
                    describe_error(error.as_ref()),
                );
                // One Claude Code let go of meanwhile is not answered, since its id may already
                // name a new request.
                if is_held {
                    deny_plan_request(
                        &tables,
                        &*channel,
                        session_id,
                        &request_id,
                        admission,
                        PLAN_UNSHOWN_REASON,
                    )
                    .await;
                }
                return;
            }
            // The newer plan's record set these plans aside, so their requests wait no more.
            for (older_request_id, older_admission) in set_aside {
                deny_plan_request(
                    &tables,
                    &*channel,
                    session_id,
                    &older_request_id,
                    older_admission,
                    PLAN_KEPT_REASON,
                )
                .await;
            }
            // Claude Code's withdrawal while the record was written is reported now that it is.
            if !is_withdrawn {
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

// Answers the plan request recorded as `admission` `deny` with `message` and lets it go; one whose
// answer could not be written is let go too, since nothing else will answer it.
async fn deny_plan_request(
    tables: &Mutex<RequestTables>,
    channel: &dyn ClaudeProcessChannel,
    session_id: SessionId,
    request_id: &str,
    admission: u64,
    message: &str,
) {
    let denial = json!({"behavior": "deny", "message": message});
    if let Err(error) =
        write_answer(tables, channel, session_id, request_id, admission, &denial).await
    {
        record_hand_off_failure(session_id, "plan", &error);
        close_recording(tables, session_id, request_id, admission);
    }
}

// Records a plan request refused because its plan could not be recorded, and why.
fn record_plan_not_recorded(
    session_id: SessionId,
    account_id: &ProviderAccountId,
    request_id: &str,
    cause: String,
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(account_id.clone()),
        kind: DriverDiagnosticKind::PlanNotRecorded,
        raw_wire_type: Some(PLAN_REQUEST_WIRE.to_owned()),
        disposition_reason: cause,
        details: Map::from_iter([
            ("sessionId".to_owned(), Value::from(session_id.to_string())),
            ("requestId".to_owned(), Value::from(request_id)),
        ]),
    });
}

#[cfg(test)]
mod tests;
