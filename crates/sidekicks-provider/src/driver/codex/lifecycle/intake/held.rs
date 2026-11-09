//! The completed responses Codex's export states that a session holds: each passed over where the
//! stream stated it, else held until its turn settles and two export intervals pass, then passed
//! over or priced on the session.

use crate::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::driver::codex::lifecycle::intake::routed_frames::attribute_codex_usage;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexHeldResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::placement::refuse_response;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner};

impl CodexSessionIntake {
    /// Passes over each of `decided` the stream stated by now, and prices the rest on their
    /// session.
    pub(super) async fn decide_held_responses(&mut self, decided: Vec<CodexHeldResponse>) {
        let mut usage = Vec::new();
        for held in decided {
            usage.extend(self.price_held_response(held));
        }
        self.record_usage(usage).await;
    }

    // `held`'s spend, filed as its owner thread's on the turn held with it, or as the session's
    // own, under the account it ran on; `None` where the stream stated it, so it is passed over,
    // or where it has no binding to file on.
    fn price_held_response(&mut self, held: CodexHeldResponse) -> Option<MeteredUsage> {
        let CodexHeldResponse {
            exported,
            turn_id,
            is_session_own,
            ..
        } = held;
        let response = &exported.response;
        if self
            .routing
            .streamed_responses()
            .claim(&response.conversation_id, &response.counts)
        {
            return None;
        }
        let Some(record) = &self.record else {
            refuse_response(response, "its session was let go before it was priced");
            return None;
        };
        let mut delta = response.meter();
        delta.attributed_turn_id.clone_from(&turn_id);
        let mut usage = attribute_codex_usage(
            &Self::routed_frames_intake(&self.parts),
            record,
            exported.owner_thread(),
            delta,
            response.provider_account_id.clone(),
        );
        if is_session_own && let Some(usage) = &mut usage {
            usage.owner = MeteredUsageOwner::Session;
        }
        // A response on a thread the session streams may still have its reading released late,
        // which is matched to it rather than counted again.
        if usage.is_some() && exported.placed.is_none() {
            let is_settled = turn_id.as_deref().is_none_or(|turn_id| {
                self.thread_turns.live_turn(&response.conversation_id) != Some(turn_id)
            });
            self.routing.streamed_responses().record_priced(
                &response.conversation_id,
                turn_id.as_deref(),
                response.counts,
                is_settled,
            );
        }
        response.log_read_for_price();
        usage
    }

    /// Takes `exported`, a completed response the drain pushed onto the session: passed over
    /// where the stream stated it, else held on its turn; one the bound pushes out is decided now.
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
        if self
            .routing
            .streamed_responses()
            .claim(&response.conversation_id, &response.counts)
        {
            return;
        }
        // A response waits on the live turn of its own thread or the held thread it was placed
        // below; one placed on a turn of the session's thread waits on it only while it is
        // live, and one on a thread the session released waits on none.
        let (turn_id, awaited_thread) = match &exported.placed {
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
