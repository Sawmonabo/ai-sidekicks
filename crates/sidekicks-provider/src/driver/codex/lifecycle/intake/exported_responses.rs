//! The completed responses Codex's export or a rollout file states that reach a session, each
//! priced as it arrives on the turn live then, with its sighting, which the usage record passes
//! over where another sighting of the same request was priced first. One its rollout file stated
//! is filed on the run the stored rows name at its record's time, and a spawned helper's takes its
//! root thread's tier from the stored rows then.

use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::BoundedText;

use crate::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::driver::codex::lifecycle::intake::routed_frames::attribute_codex_usage;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::placement::refuse_response;
use crate::driver::codex::telemetry::sighting::compose_codex_sighting;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};

impl CodexSessionIntake {
    /// Prices `exported`, a completed response the drain or the rollout fallback pushed onto the
    /// session, with its sighting.
    pub(super) async fn price_exported_response(&mut self, mut exported: CodexExportedResponse) {
        // With no record registered, nothing is recorded, so nothing is read.
        if let Some(sink) = self.parts.ports.usage.port().map(Arc::clone)
            && !read_rollout_filing(&*sink, self.session_id, &mut exported).await
        {
            return;
        }
        let usage = self.meter_exported_response(&exported);
        self.record_usage(usage.into_iter().collect()).await;
    }

    // `exported`'s spend with its sighting, filed as its owner thread's on the turn it is filed on,
    // or as the session's own, under the account it ran on; `None` where its session was let go or
    // it has no binding to file on. A response waits on no turn: one on a thread the session holds
    // is filed on that thread's live turn, one placed on a turn of the session's thread on that
    // turn, and one on a thread the session released, or read from its rollout file, on none, a
    // rollout one's run read by its record's time.
    fn meter_exported_response(&self, exported: &CodexExportedResponse) -> Option<MeteredUsage> {
        let response = &exported.response;
        let Some(record) = &self.record else {
            refuse_response(response, "it reached a session already let go");
            return None;
        };
        let turn_id = match &exported.placed {
            _ if exported.rollout.is_some() => None,
            Some(CodexOffStreamPlacement::OnTurn { turn_id }) => Some(turn_id.clone()),
            Some(CodexOffStreamPlacement::BelowThread { session_thread, .. }) => self
                .thread_turns
                .live_turn(session_thread)
                .map(str::to_owned),
            Some(CodexOffStreamPlacement::Released) => None,
            None => self
                .thread_turns
                .live_turn(&response.conversation_id)
                .map(str::to_owned),
        };
        let mut delta = response.meter();
        delta.attributed_turn_id = turn_id;
        let (source, response_id) = match &exported.rollout {
            Some(rollout) => {
                delta.request.request_key = Some(rollout.request_key.clone());
                (
                    UsageSightingSource::File,
                    Some(rollout.request_key.as_str()),
                )
            }
            None => (UsageSightingSource::Export, None),
        };
        delta.sighting = compose_codex_sighting(
            source,
            &response.conversation_id,
            &response.counts,
            response_id,
        );
        let filing_run = exported
            .rollout
            .as_ref()
            .and_then(|rollout| rollout.filing_run);
        let mut usage = attribute_codex_usage(
            &Self::routed_frames_intake(&self.parts),
            record,
            exported.owner_thread(),
            delta,
            filing_run,
            response.provider_account_id.clone(),
        );
        // A live side question's copy's spend is the session's own beside its runs.
        if record
            .service
            .is_side_question_thread(&response.conversation_id)
            && let Some(usage) = &mut usage
        {
            usage.owner = MeteredUsageOwner::Session;
        }
        response.log_read_for_price();
        usage
    }
}

// Reads what `exported` is filed on where its rollout file stated it, answering whether it is still
// to be priced on `session_id`: the run of the session's stored rows at its record's time, and for
// a spawned helper's the thread tier those rows carry then, the standard rates where none carries
// one. One the record cannot be read for is refused; any other answers at once.
async fn read_rollout_filing(
    sink: &dyn UsageSink,
    session_id: SessionId,
    exported: &mut CodexExportedResponse,
) -> bool {
    let Some(rollout) = &mut exported.rollout else {
        return true;
    };
    let response = &mut exported.response;
    let at = i64::try_from(response.observed_at_ms)
        .ok()
        .and_then(|at_ms| jiff::Timestamp::from_millisecond(at_ms).ok())
        .and_then(WireInstant::from_timestamp);
    let Some(at) = at else {
        refuse_response(response, "its record's time does not read");
        return false;
    };
    match sink.read_run_at(session_id, at.clone()).await {
        Ok(filing_run) => rollout.filing_run = filing_run,
        Err(error) => {
            tracing::warn!(
                error = &*error as &(dyn std::error::Error + 'static),
                "the run a codex rollout response ran in could not be read"
            );
            refuse_response(response, "the run that held its turn could not be read");
            return false;
        }
    }
    if !rollout.is_root_tier {
        return true;
    }
    match sink.read_thread_speed_at(session_id, at).await {
        Ok(thread_speed) => {
            if thread_speed.is_none() {
                tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    "a codex helper's rollout response is priced at the standard rates: no \
                     stored row of its session carries a thread tier at its time"
                );
            }
            response.service_tier = thread_speed.and_then(BoundedText::new);
            true
        }
        Err(error) => {
            tracing::warn!(
                error = &*error as &(dyn std::error::Error + 'static),
                "a codex helper's root thread tier could not be read"
            );
            refuse_response(response, "its root thread's tier could not be read");
            false
        }
    }
}

#[cfg(test)]
mod tests;
