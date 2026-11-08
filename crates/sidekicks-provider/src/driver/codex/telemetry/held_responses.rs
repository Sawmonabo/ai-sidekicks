//! The export's completed responses one session holds until its stream could have stated them,
//! then passes over or prices.

use std::collections::VecDeque;

use tokio::time::Instant;

use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;

/// How many responses one session holds at once; past it the oldest is decided at once.
pub(crate) const HELD_RESPONSES_KEPT: usize = 256;

/// One completed response the export read, and when the export carrying it arrived.
pub(crate) struct CodexExportedResponse {
    /// The response.
    pub(crate) response: CodexCompletedResponse,
    /// When the export carrying it was read.
    pub(crate) arrived_at: Instant,
}

/// A response a session holds, with the turn live on its thread when it arrived.
pub(crate) struct CodexHeldResponse {
    /// The response.
    pub(crate) exported: CodexExportedResponse,
    /// The turn live on the response's thread at its arrival, which it is filed on.
    pub(crate) live_turn: Option<String>,
    // Whether that turn settled; a response with no live turn waits on none.
    is_turn_settled: bool,
}

impl CodexHeldResponse {
    // When the response may be decided: two export intervals after its arrival, once its turn
    // settled or where it had none; `None` while its turn is live.
    fn decision_at(&self) -> Option<Instant> {
        (self.live_turn.is_none() || self.is_turn_settled)
            .then(|| self.exported.arrived_at + CODEX_EXPORT_INTERVAL * 2)
    }
}

/// The responses one session holds, oldest first, each decided at the later of its turn's settle
/// and two export intervals after its arrival, when every reading of that turn is in the ledger.
#[derive(Default)]
pub(crate) struct CodexHeldResponses {
    held: VecDeque<CodexHeldResponse>,
}

impl CodexHeldResponses {
    /// Holds `exported` with the turn live on its thread; answers the oldest response the bound
    /// pushes out, which the caller decides at once.
    pub(crate) fn hold(
        &mut self,
        exported: CodexExportedResponse,
        live_turn: Option<String>,
    ) -> Option<CodexHeldResponse> {
        let pushed_out = if self.held.len() >= HELD_RESPONSES_KEPT {
            self.held.pop_front()
        } else {
            None
        };
        self.held.push_back(CodexHeldResponse {
            exported,
            live_turn,
            is_turn_settled: false,
        });
        pushed_out
    }

    /// The turn `turn_id` on `thread_id` settled or went: every response held on it may be decided.
    pub(crate) fn turn_settled(&mut self, thread_id: &str, turn_id: &str) {
        for held in &mut self.held {
            if held.exported.response.conversation_id == thread_id
                && held.live_turn.as_deref() == Some(turn_id)
            {
                held.is_turn_settled = true;
            }
        }
    }

    /// The earliest instant a held response may be decided, `None` while each waits on its turn.
    pub(crate) fn next_decision(&self) -> Option<Instant> {
        self.held
            .iter()
            .filter_map(CodexHeldResponse::decision_at)
            .min()
    }

    /// Takes every response that may be decided at `now`, oldest first.
    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<CodexHeldResponse> {
        let (due, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.held)
            .into_iter()
            .partition(|held| held.decision_at().is_some_and(|decision| decision <= now));
        self.held = kept;
        due.into()
    }

    /// Takes every held response, oldest first, for a session that is let go.
    pub(crate) fn take_all(&mut self) -> Vec<CodexHeldResponse> {
        self.held.drain(..).collect()
    }
}
