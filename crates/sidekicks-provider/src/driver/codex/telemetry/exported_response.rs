//! A completed response a session prices as it arrives: one the export stated, with where the
//! drain placed it off the session's stream, or one its rollout file stated while the export was
//! absent.

use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::BoundedText;

use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;

/// One completed response the export or a rollout file stated, with the account it ran on, and
/// where the drain placed it when no session streams its thread.
pub(crate) struct CodexExportedResponse {
    /// The response, carrying the account it ran on.
    pub(crate) response: CodexCompletedResponse,
    /// Where it was placed off the session's stream; `None` on a thread the session streams.
    pub(crate) placed: Option<CodexOffStreamPlacement>,
    /// What a response read from its rollout file carries; `None` for one an export stated.
    pub(crate) rollout: Option<CodexRolloutFacts>,
}

/// What a response read from its rollout file carries beside its counts: the key its rows are
/// stored under, which passes over the line read a second time, whether its tier is its root
/// thread's, and the run it is filed on, both read from the session's stored rows at its record's
/// time as it is priced.
#[derive(Clone)]
pub(crate) struct CodexRolloutFacts {
    /// Codex's id of the response.
    pub(crate) request_key: BoundedText<1, EVENT_FIELD_MAX_LEN>,
    /// Whether a spawned helper sent it, at its root thread's tier.
    pub(crate) is_root_tier: bool,
    /// The run that held the session's turn at its record's time; `None` until it is read, and
    /// where no run did, so it is the session's own.
    pub(crate) filing_run: Option<RunId>,
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
    /// On its own thread, which the session streamed on the response's launch before releasing
    /// it and another launch streams now, so no stream of this session states it.
    Released,
}

impl CodexExportedResponse {
    /// The thread the response is filed as: the child it was placed through, else its own.
    pub(crate) fn owner_thread(&self) -> &str {
        match &self.placed {
            None
            | Some(CodexOffStreamPlacement::OnTurn { .. } | CodexOffStreamPlacement::Released) => {
                &self.response.conversation_id
            }
            Some(CodexOffStreamPlacement::BelowThread { child_thread, .. }) => child_thread,
        }
    }
}
