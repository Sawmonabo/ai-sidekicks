//! The hand-over brief's summary on Codex: an ephemeral, read-only copy of the session's stored
//! conversation, forked over a connection of its own, answers the fixed template in one turn. The
//! session's own conversation is never touched, the copy's cost is metered and priced on the
//! session's binding, and the copy goes with its connection once its turn ended.

use std::sync::Arc;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::pricing::CodexRecorderPricing;
use crate::driver::codex::session::detached_conversation::{DetachedTurnRead, read_detached_turn};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::side_questions::copy_turn::{
    CopyTurn, CopyTurnFailure, CopyTurnMeter, SessionUsageFiling,
};
use crate::driver::codex::session::side_questions::resting_copy::fork_resting_copy;
use crate::driver::codex::session::side_questions::start_turn;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::provider_failure_refusal;
use crate::driver::session_control::{
    DriverHandoverBriefResult, ExportHandoverBriefParams, HandoverSummaryKind,
};
use crate::hand_over::brief::HANDOVER_SUMMARY_TEMPLATE;

impl CodexDriver {
    /// The session's hand-over summary: the answer an ephemeral, read-only copy of its stored
    /// conversation gives the fixed template, the copy's cost metered and priced on the session's
    /// binding.
    /// Refused `provider.unavailable` in Codex's words where the copy's turn gave no answer; fails
    /// as the copy cannot be forked or its turn started.
    pub(crate) async fn export_handover_brief(
        &self,
        params: ExportHandoverBriefParams,
    ) -> Result<DriverHandoverBriefResult, DriverError> {
        let parts = self.parts()?;
        let filing = SessionUsageFiling {
            usage: Arc::clone(&parts.ports.usage),
            session_id: params.session_id,
            binding_id: params.binding_id.clone(),
            provider_account_id: params.resume.provider_account_id.clone(),
            pricing: CodexRecorderPricing::new(Arc::clone(&parts.pricing)),
        };
        Ok(summarize_on_copy(&parts.establishment, &params, filing).await?)
    }
}

/// Forks `params`' stored conversation into a read-only copy, asks it the template and reads its
/// turn to its end, each usage reading filed through `filing` at the copy's model and declared
/// tier. Fails as [`CodexDriver::export_handover_brief`] fails.
async fn summarize_on_copy(
    establishment: &CodexSessionEstablishment,
    params: &ExportHandoverBriefParams,
    mut filing: SessionUsageFiling,
) -> Result<DriverHandoverBriefResult, CodexError> {
    // The service is held until the copy's turn ended; the copy goes with its connection.
    // The person's own summary runs with the session's folder trusted, as the session does.
    let is_project_untrusted = false;
    let (service, mut copy) =
        fork_resting_copy(establishment, &params.resume, is_project_untrusted).await?;
    // Held until the copy's read ends, so the export's twins of its filed requests pass over.
    let _copy_read = service.dependencies().exports.copy_thread(
        service.id(),
        &copy.thread_id,
        &filing,
        &copy.working_directory,
    );
    start_turn(
        &copy.connection,
        &copy.thread_id,
        &copy.working_directory,
        HANDOVER_SUMMARY_TEMPLATE,
    )
    .await?;
    let mut meter = CopyTurnMeter::new(
        copy.thread_id.clone(),
        Some(&copy.model),
        copy.declared_tier.as_ref(),
    );
    // The hand-over has no stop of its own: the copy is read to its turn's end.
    let read = read_detached_turn(
        &mut copy.frames,
        &mut meter,
        &mut filing,
        &service,
        &copy.working_directory,
        std::future::pending(),
    )
    .await;
    let DetachedTurnRead { answer, turn } = read.unwrap_or(DetachedTurnRead {
        answer: None,
        turn: None,
    });
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
