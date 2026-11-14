//! A completed response a session prices as it arrives: one the export stated, with where the
//! drain placed it off the session's stream, or a charge its rollout file stated while the export
//! was absent, a response's counts or a hosted web search.

use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::rollouts::file::{
    CodexRolloutCharge, CodexRolloutRequest, CodexRolloutTier,
};
use crate::usage_delta_accountant::UsageAxisCounts;

/// One completed response the export or a rollout file stated, or a search a rollout file stated
/// riding on a response of no counts, with the account it ran on, and where the drain placed it
/// when no session streams its thread.
pub(crate) struct CodexExportedResponse {
    /// The response, carrying the account it ran on.
    pub(crate) response: CodexCompletedResponse,
    /// Where it was placed off the session's stream; `None` on a thread the session streams.
    pub(crate) placed: Option<CodexOffStreamPlacement>,
    /// What a charge read from its rollout file carries; `None` for one an export stated.
    pub(crate) rollout: Option<CodexRolloutFacts>,
}

/// What a charge read from its rollout file carries beside its counts: what its line charges,
/// whether its tier is its root thread's, and the run it is filed on, both read from the session's
/// stored rows at its line's time as it is priced.
#[derive(Clone)]
pub(crate) struct CodexRolloutFacts {
    /// What the line charges.
    pub(crate) line: CodexRolloutLine,
    /// Whether a spawned helper sent it, at its root thread's tier.
    pub(crate) is_root_tier: bool,
    /// The run that held the session's turn at its record's time; `None` until it is read, and
    /// where no run did, so it is the session's own.
    pub(crate) filing_run: Option<RunId>,
}

/// What a rollout line read for price charges.
#[derive(Clone)]
pub(crate) enum CodexRolloutLine {
    /// A completed response's counts, its rows stored under Codex's id of the response, which
    /// passes over the line read a second time.
    Response {
        /// Codex's id of the response.
        request_key: BoundedText<1, EVENT_FIELD_MAX_LEN>,
    },
    /// One billed hosted web search, by its item's id, the stream's item id too, so the search is
    /// charged once whichever names it first; the response it rides on carries no counts.
    Search {
        /// The search item's id.
        search_id: String,
    },
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
    /// The charge `request` of `thread_id`'s rollout file states, placed at `placed`, under
    /// `provider_account_id`, the account its line's time ran on; a search rides on a response of
    /// no counts. `None`, logged, where its model or key does not fit the wire.
    pub(crate) fn from_rollout(
        thread_id: &str,
        request: CodexRolloutRequest,
        placed: Option<CodexOffStreamPlacement>,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Option<Self> {
        let (service_tier, is_root_tier) = match request.tier {
            CodexRolloutTier::Snapshot(tier) => (tier.and_then(BoundedText::new), false),
            CodexRolloutTier::RootThread => (None, true),
        };
        let (line, counts) = match request.charge {
            CodexRolloutCharge::Response {
                response_id,
                counts,
            } => (
                BoundedText::new(response_id)
                    .map(|request_key| CodexRolloutLine::Response { request_key }),
                counts,
            ),
            CodexRolloutCharge::Search { search_id } => (
                Some(CodexRolloutLine::Search { search_id }),
                UsageAxisCounts::default(),
            ),
        };
        let (Ok(model_id), Some(line)) = (FreeFormText::new(request.model), line) else {
            tracing::warn!(
                conversation_id = thread_id,
                "a codex rollout line's model or response id does not fit the wire; it is refused"
            );
            return None;
        };
        Some(Self {
            response: CodexCompletedResponse {
                conversation_id: thread_id.to_owned(),
                model_id,
                service_tier,
                counts,
                observed_at_ms: request.at_ms,
                provider_account_id,
            },
            placed,
            rollout: Some(CodexRolloutFacts {
                line,
                is_root_tier,
                filing_run: None,
            }),
        })
    }

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
