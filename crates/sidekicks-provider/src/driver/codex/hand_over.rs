//! The hand-over brief's summary on Codex: an ephemeral, read-only copy of the session's stored
//! conversation, forked over a connection of its own, answers the fixed template in one turn. The
//! session's own conversation is never touched, the copy's cost is metered on the session's
//! binding, and the copy goes with its connection once its turn ended.

use std::sync::Arc;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::side_questions::copy_turn::{
    CopyFrameReading, CopyTurn, CopyTurnFailure, read_copy_frame,
};
use crate::driver::codex::session::side_questions::resting_copy::fork_resting_copy;
use crate::driver::codex::session::side_questions::{file_copy_usage, start_turn};
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::provider_failure_refusal;
use crate::driver::session_control::{
    DriverHandoverBriefResult, ExportHandoverBriefParams, HandoverSummaryKind,
};
use crate::hand_over::brief::HANDOVER_SUMMARY_TEMPLATE;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};
use crate::usage_delta_accountant::{ThreadBaseEstablishment, UsageDeltaAccountant};

impl CodexDriver {
    /// The session's hand-over summary: the answer an ephemeral, read-only copy of its stored
    /// conversation gives the fixed template, the copy's cost metered on the session's binding.
    /// Refused `provider.unavailable` in Codex's words where the copy's turn gave no answer; fails
    /// as the copy cannot be forked or its turn started.
    pub(crate) async fn export_handover_brief(
        &self,
        params: ExportHandoverBriefParams,
    ) -> Result<DriverHandoverBriefResult, DriverError> {
        let parts = self.parts()?;
        Ok(summarize_on_copy(&parts.establishment, &params, &parts.ports.usage).await?)
    }
}

/// Forks `params`' stored conversation into a read-only copy, asks it the template and reads its
/// turn to its end, each usage reading filed through `usage`. Fails as
/// [`CodexDriver::export_handover_brief`] fails.
async fn summarize_on_copy(
    establishment: &CodexSessionEstablishment,
    params: &ExportHandoverBriefParams,
    usage: &PortRegistration<Arc<dyn UsageSink>>,
) -> Result<DriverHandoverBriefResult, CodexError> {
    // The service is held until the copy's turn ended; the copy goes with its connection.
    let (_service, mut copy) = fork_resting_copy(establishment, &params.resume).await?;
    start_turn(
        &copy.connection,
        &copy.thread_id,
        &copy.working_directory,
        HANDOVER_SUMMARY_TEMPLATE,
    )
    .await?;
    // Fresh for the copy, so its cost never takes the session's own counts as its base.
    let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
    accountant.establish_thread(copy.thread_id.clone(), ThreadBaseEstablishment::Fresh);
    let mut answer = None;
    let mut turn = None;
    while let Some((method, frame)) = copy.frames.recv().await {
        if read_codex_frame_thread_id(&method, &frame).as_deref() != Some(copy.thread_id.as_str()) {
            continue;
        }
        match read_copy_frame(&method, &frame, &mut accountant) {
            CopyFrameReading::Reply(text) => answer = Some(text),
            CopyFrameReading::Usage(delta) => {
                let metered = MeteredUsage {
                    session_id: params.session_id,
                    binding_id: params.binding_id.clone(),
                    owner: MeteredUsageOwner::SessionCopy,
                    delta: *delta,
                };
                file_copy_usage(usage, metered, &params.resume.provider_account_id).await;
            }
            CopyFrameReading::Ended(ended) => {
                turn = ended;
                break;
            }
            CopyFrameReading::Other => {}
        }
    }
    match answer.filter(|answer| !answer.trim().is_empty()) {
        Some(summary) if CopyTurn::is_completed(turn.as_ref()) => Ok(
            DriverHandoverBriefResult::summarized(summary, HandoverSummaryKind::Template),
        ),
        Some(_) | None => Err(CodexError::Driver(DriverError::from(
            provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "Codex gave the hand-over summary no answer",
                RefusalCode::ProviderUnavailable,
                CopyTurnFailure::of(turn.and_then(|turn| turn.error).as_ref()),
            ),
        ))),
    }
}

#[cfg(test)]
mod tests;
