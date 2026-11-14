//! The completed responses Codex's export or a rollout file states that reach a session, one
//! hand-over at a time, each priced on the turn live then, with its sighting, which the usage
//! record passes over where another sighting of the same request was priced first; a hand-over's
//! sightings are recorded together, so they take one commit. One its rollout file stated is filed
//! on the run the stored rows name at its record's time, and a spawned helper's takes its root
//! thread's tier from the stored rows then. One the session cannot file, since its record was let
//! go, its time or stored rows do not read, or it has no binding to file on, is charged through
//! the hand-over's launch charge as its account's spend outside any session, with its sighting.

use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::BoundedText;

use crate::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::driver::codex::lifecycle::intake::routed_frames::attribute_codex_usage;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement, CodexRolloutLine,
};
use crate::driver::codex::telemetry::sessionless_spend::CodexLaunchCharge;
use crate::driver::codex::telemetry::sighting::compose_codex_sighting;
use crate::driver::codex::web_search::CodexWebSearch;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};

impl CodexSessionIntake {
    /// Prices `hand_over`, the completed responses the drain or the rollout fallback pushed onto
    /// the session together, each with its sighting, recorded as one batch; those the session
    /// cannot file are charged through `charge` as their accounts' spend outside any session.
    pub(super) async fn price_exported_responses(
        &mut self,
        hand_over: Vec<CodexExportedResponse>,
        charge: CodexLaunchCharge,
    ) {
        let sink = self.parts.ports.usage.port().map(Arc::clone);
        let mut usage = Vec::with_capacity(hand_over.len());
        let mut unfiled = Vec::new();
        for mut exported in hand_over {
            // With no usage record registered, nothing is recorded, so nothing is read.
            let is_filed = self.record.is_some()
                && match &sink {
                    Some(sink) => {
                        read_rollout_filing(&**sink, self.session_id, &mut exported).await
                    }
                    None => true,
                };
            match is_filed
                .then(|| self.meter_exported_response(&exported))
                .flatten()
            {
                Some(metered) => usage.push(metered),
                None => unfiled.push(exported),
            }
        }
        self.record_usage(usage).await;
        if !unfiled.is_empty() {
            charge.charge_exported(unfiled);
        }
    }

    // `exported`'s spend with its sighting, filed as its owner thread's on the turn it is filed on,
    // or as the session's own, under the account it ran on; `None` where its session was let go or
    // it has no binding to file on. A response waits on no turn: one on a thread the session holds
    // is filed on that thread's live turn, one placed on a turn of the session's thread on that
    // turn, and one on a thread the session released, or read from its rollout file, on none, a
    // rollout one's run read by its record's time.
    fn meter_exported_response(&self, exported: &CodexExportedResponse) -> Option<MeteredUsage> {
        let response = &exported.response;
        let record = self.record.as_ref()?;
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
        match exported.rollout.as_ref().map(|rollout| &rollout.line) {
            Some(CodexRolloutLine::Search { search_id }) => {
                let search = CodexWebSearch::new(&response.conversation_id, search_id);
                delta = search.meter(UsageSightingSource::File, delta.request);
            }
            Some(CodexRolloutLine::Response { request_key }) => {
                delta.request.request_key = Some(request_key.clone());
                delta.sighting = compose_codex_sighting(
                    UsageSightingSource::File,
                    &response.conversation_id,
                    &response.counts,
                    Some(request_key.as_str()),
                );
            }
            None => {
                delta.sighting = compose_codex_sighting(
                    UsageSightingSource::Export,
                    &response.conversation_id,
                    &response.counts,
                    None,
                );
            }
        }
        delta.attributed_turn_id = turn_id;
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
        )
        .ok();
        // A live side question's copy's spend is the session's own beside its runs.
        if record
            .service
            .is_side_question_thread(&response.conversation_id)
            && let Some(usage) = &mut usage
        {
            usage.owner = MeteredUsageOwner::Session;
        }
        // One with no binding is logged by the charge that takes it.
        if usage.is_some() {
            response.log_read_for_price();
        }
        usage
    }
}

// Reads what `exported` is filed on where its rollout file stated it, answering whether it is to
// be priced on `session_id`: the run of the session's stored rows at its record's time, and for a
// spawned helper's the thread tier those rows carry then, the standard rates where none carries
// one. One whose record cannot be read for is logged and answers `false`, for its caller to
// charge outside any session; any other answers at once.
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
        tracing::warn!(
            conversation_id = response.conversation_id.as_str(),
            "a codex rollout response's time does not read; it is charged outside any session"
        );
        return false;
    };
    match sink.read_run_at(session_id, at.clone()).await {
        Ok(filing_run) => rollout.filing_run = filing_run,
        Err(error) => {
            tracing::warn!(
                error = &*error as &(dyn std::error::Error + 'static),
                "the run a codex rollout response ran in could not be read; it is charged outside \
                 any session"
            );
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
                "a codex helper's root thread tier could not be read; its response is charged \
                 outside any session"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests;
