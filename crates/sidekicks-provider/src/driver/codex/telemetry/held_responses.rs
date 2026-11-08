//! The export's completed responses one session holds until its stream could have stated them,
//! then passes over or prices.

use std::collections::VecDeque;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;

use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;

/// How many responses one session holds at once; past it the oldest is decided at once.
pub(crate) const HELD_RESPONSES_KEPT: usize = 256;

/// One completed response the export read, when the export carrying it arrived, and where the
/// drain placed it when no session streams its thread.
pub(crate) struct CodexExportedResponse {
    /// The response.
    pub(crate) response: CodexCompletedResponse,
    /// When the export carrying it was read.
    pub(crate) arrived_at: Instant,
    /// Where it was placed off the session's stream; `None` on a thread the session streams.
    pub(crate) placed: Option<CodexOffStreamPlacement>,
    /// The account it ran under, set only on a response whose launch streamed its thread before
    /// the thread moved to another launch; `None` where it ran on its binding's account.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// Where the drain placed a response on a thread no session streams.
#[derive(Clone)]
pub(crate) enum CodexOffStreamPlacement {
    /// Below `session_thread`, a thread the session holds, through `child_thread`, the thread
    /// one hop below it, which the response is filed as.
    BelowThread {
        /// The held thread, whose live turn the response is filed on.
        session_thread: String,
        /// The thread one hop below it, which files the response.
        child_thread: String,
    },
    /// On `turn_id` of the session's own thread: the turn of the review window it was joined to,
    /// or the turn live when its first record was observed.
    OnTurn {
        /// The turn it is filed on.
        turn_id: String,
    },
}

impl CodexExportedResponse {
    /// The thread the response is filed as: the child it was placed through, else its own.
    pub(crate) fn owner_thread(&self) -> &str {
        match &self.placed {
            None | Some(CodexOffStreamPlacement::OnTurn { .. }) => &self.response.conversation_id,
            Some(CodexOffStreamPlacement::BelowThread { child_thread, .. }) => child_thread,
        }
    }
}

/// A response a session holds, with the turn it is filed on.
pub(crate) struct CodexHeldResponse {
    /// The response.
    pub(crate) exported: CodexExportedResponse,
    /// The turn the response is filed on, `None` where no turn was live on its thread.
    pub(crate) turn_id: Option<String>,
    // The thread and turn whose settle the response waits for; `None` once it settled, or where
    // it waits on none.
    awaited: Option<(String, String)>,
}

impl CodexHeldResponse {
    // When the response may be decided: two export intervals after its arrival, once its turn
    // settled or where it awaits none; `None` while its turn is live.
    fn decision_at(&self) -> Option<Instant> {
        self.awaited
            .is_none()
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
    /// Holds `exported`, filed on `turn_id`, waiting for that turn's settle on `awaited_thread`
    /// where one is named; answers the oldest response the bound pushes out, which the caller
    /// decides at once.
    pub(crate) fn hold(
        &mut self,
        exported: CodexExportedResponse,
        turn_id: Option<String>,
        awaited_thread: Option<String>,
    ) -> Option<CodexHeldResponse> {
        let pushed_out = if self.held.len() >= HELD_RESPONSES_KEPT {
            self.held.pop_front()
        } else {
            None
        };
        let awaited = awaited_thread.zip(turn_id.clone());
        self.held.push_back(CodexHeldResponse {
            exported,
            turn_id,
            awaited,
        });
        pushed_out
    }

    /// The turn `turn_id` on `thread_id` settled or went: every response waiting on it may be
    /// decided.
    pub(crate) fn turn_settled(&mut self, thread_id: &str, turn_id: &str) {
        for held in &mut self.held {
            if held
                .awaited
                .as_ref()
                .is_some_and(|(thread, turn)| thread == thread_id && turn == turn_id)
            {
                held.awaited = None;
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
