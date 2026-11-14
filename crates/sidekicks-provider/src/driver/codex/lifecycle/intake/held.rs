//! The completed responses Codex's export states that a session holds, each held until its turn
//! settles, then priced on the session with its sighting, which the usage record passes over where
//! another sighting of the same request was priced first. One its rollout file stated is filed on
//! the run the stored rows name at its record's time, and a spawned helper's takes its root
//! thread's tier from the stored rows then.

use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::BoundedText;

use crate::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::driver::codex::lifecycle::intake::routed_frames::attribute_codex_usage;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexHeldResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::placement::refuse_response;
use crate::driver::codex::telemetry::sighting::compose_codex_sighting;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};

impl CodexSessionIntake {
    /// Prices each of `decided` on its session, each with its sighting.
    pub(super) async fn decide_held_responses(&mut self, decided: Vec<CodexHeldResponse>) {
        // With no record registered, nothing is recorded, so nothing is read.
        let sink = self.parts.ports.usage.port().map(Arc::clone);
        let mut usage = Vec::new();
        for mut held in decided {
            let is_priced = match &sink {
                Some(sink) => {
                    read_rollout_filing(&**sink, self.session_id, &mut held.exported).await
                }
                None => true,
            };
            if is_priced {
                usage.extend(self.price_held_response(held));
            }
        }
        self.record_usage(usage).await;
    }

    // `held`'s spend with its sighting, filed as its owner thread's on the turn held with it, or as
    // the session's own, under the account it ran on; `None` where it has no binding to file on.
    fn price_held_response(&mut self, held: CodexHeldResponse) -> Option<MeteredUsage> {
        let CodexHeldResponse {
            exported,
            turn_id,
            is_session_own,
            ..
        } = held;
        let response = &exported.response;
        let Some(record) = &self.record else {
            refuse_response(response, "its session was let go before it was priced");
            return None;
        };
        let mut delta = response.meter();
        delta.attributed_turn_id.clone_from(&turn_id);
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
        if is_session_own && let Some(usage) = &mut usage {
            usage.owner = MeteredUsageOwner::Session;
        }
        response.log_read_for_price();
        usage
    }

    /// Holds as the session's own, while its record still files them, the rollout requests its
    /// launches held for it that no exported response matches, since no export after its let-go
    /// is filed on it.
    pub(super) async fn take_held_rollouts(&mut self) {
        let Some(record) = &self.record else {
            return;
        };
        let exported: Vec<CodexExportedResponse> = record
            .service
            .dependencies()
            .exports
            .take_session_rollouts(self.session_id)
            .into_iter()
            .filter_map(|held| held.into_exported(&record.service))
            .collect();
        for exported in exported {
            self.hold_exported_response(exported).await;
        }
    }

    /// Takes `exported`, a completed response the drain pushed onto the session, held on its turn;
    /// one the bound pushes out is decided now.
    pub(super) async fn hold_exported_response(&mut self, exported: CodexExportedResponse) {
        let response = &exported.response;
        let Some(record) = &self.record else {
            refuse_response(response, "it reached a session already let go");
            return;
        };
        let own_thread = record.thread_id.clone();
        let is_session_own = record
            .service
            .is_side_question_thread(&response.conversation_id);
        // A response waits on the live turn of its own thread or the held thread it was placed
        // below; one placed on a turn of the session's thread waits on it only while it is
        // live, and one on a thread the session released waits on none. One read from its
        // rollout file waits on none: its run is read by its record's time as it is decided.
        let (turn_id, awaited_thread) = match &exported.placed {
            _ if exported.rollout.is_some() => (None, None),
            Some(CodexOffStreamPlacement::OnTurn { turn_id }) => {
                let is_live = self.thread_turns.live_turn(&own_thread) == Some(turn_id.as_str());
                (Some(turn_id.clone()), is_live.then_some(own_thread))
            }
            Some(CodexOffStreamPlacement::BelowThread { session_thread, .. }) => {
                let turn_id = self.thread_turns.live_turn(session_thread);
                (turn_id.map(str::to_owned), Some(session_thread.clone()))
            }
            Some(CodexOffStreamPlacement::Released) => (None, None),
            None => {
                let turn_id = self.thread_turns.live_turn(&response.conversation_id);
                (
                    turn_id.map(str::to_owned),
                    Some(response.conversation_id.clone()),
                )
            }
        };
        if let Some(pushed_out) = self
            .held
            .hold(exported, turn_id, awaited_thread, is_session_own)
        {
            tracing::debug!(
                conversation_id = pushed_out.exported.response.conversation_id.as_str(),
                "a codex session's held responses are full; the oldest is decided now"
            );
            self.decide_held_responses(vec![pushed_out]).await;
        }
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
