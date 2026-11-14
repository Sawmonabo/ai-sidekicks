//! What a launch's rollout fallback decides each rollout request against: the launch's newest
//! exported responses, by their identity, and the requests a rollout file stated that no export
//! read so far can rule on. A held request is decided once an export whose newest record is later
//! than its stamp is read, once no export can still arrive with it, as its session lets go, as the
//! launch ends, or as the hold is full: passed over where an exported response matches it, else
//! priced on its session from the file.

use std::collections::VecDeque;
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::time::Instant;

use crate::bounded_queue::remember;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::push_exported_response;
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_ARRIVAL_BOUND;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexOffStreamPlacement, CodexRolloutFacts,
};
use crate::driver::codex::telemetry::placement::refuse_unplaced;
use crate::driver::codex::telemetry::rollouts::file::{CodexRolloutRequest, CodexRolloutTier};
use crate::usage_delta_accountant::{UsageAxisCounts, is_same_counts};

/// How many of a launch's newest exported responses are kept by their identity, so a rollout
/// record of one is passed over.
const EXPORTED_RESPONSES_KEPT: usize = 256;

/// How many rollout requests a launch holds at once, no more than the exported responses it
/// keeps, so an exported response a held request's decision needs is not pushed out before it;
/// past it the oldest is decided at once, as one no export can still carry.
const HELD_REQUESTS_KEPT: usize = EXPORTED_RESPONSES_KEPT;

/// A response an export of the launch carried, as a rollout record of it is told: its thread, its
/// six counts, and when Codex logged it, in Unix milliseconds, 0 where its record carries no time.
pub(crate) struct CodexExportedIdentity {
    /// The thread it was made on.
    pub(crate) thread_id: String,
    /// Its own counts.
    pub(crate) counts: UsageAxisCounts,
    /// When Codex logged it.
    pub(crate) observed_at_ms: u64,
}

/// One request a rollout file stated that no export read so far rules on, with the session and
/// the placement it is filed on, and when no export can still arrive with it.
pub(crate) struct CodexHeldRolloutRequest {
    session_id: SessionId,
    thread_id: String,
    placed: Option<CodexOffStreamPlacement>,
    request: CodexRolloutRequest,
    due_at: Instant,
}

impl CodexHeldRolloutRequest {
    /// `request`, of `thread_id`'s file, filed on `session_id` at `placed`, `None` on the thread
    /// the session streams; due once the longest an export can take to arrive has passed since
    /// its stamp, which Codex writes only after it logs the response, and never later than that
    /// from now.
    pub(crate) fn new(
        session_id: SessionId,
        thread_id: String,
        placed: Option<CodexOffStreamPlacement>,
        request: CodexRolloutRequest,
    ) -> Self {
        let since_stamp = Duration::from_millis(read_unix_time_ms().saturating_sub(request.at_ms));
        Self {
            session_id,
            thread_id,
            placed,
            request,
            due_at: Instant::now() + CODEX_EXPORT_ARRIVAL_BOUND.saturating_sub(since_stamp),
        }
    }

    /// The request as a completed response its session files, under the account its record's
    /// time ran on on `service`; `None`, refused and logged, where its model or key does not fit
    /// the wire.
    pub(crate) fn into_exported(self, service: &CodexService) -> Option<CodexExportedResponse> {
        let request = self.request;
        let (service_tier, is_root_tier) = match request.tier {
            CodexRolloutTier::Snapshot(tier) => (tier.and_then(BoundedText::new), false),
            CodexRolloutTier::RootThread => (None, true),
        };
        let (Ok(model_id), Some(request_key)) = (
            FreeFormText::new(request.model),
            BoundedText::new(request.response_id),
        ) else {
            tracing::warn!(
                conversation_id = self.thread_id.as_str(),
                "a codex rollout record's model or response id does not fit the wire; it is refused"
            );
            return None;
        };
        Some(CodexExportedResponse {
            response: CodexCompletedResponse {
                conversation_id: self.thread_id,
                model_id,
                service_tier,
                counts: request.counts,
                observed_at_ms: request.at_ms,
                provider_account_id: service.account_at(request.at_ms),
            },
            arrived_at: Instant::now(),
            placed: self.placed,
            rollout: Some(CodexRolloutFacts {
                request_key,
                is_root_tier,
                filing_run: None,
            }),
        })
    }
}

/// Prices each of `requests` on its session through `service`; with the service gone each is
/// refused and counted, naming its thread.
pub(crate) fn price_rollout_requests(
    service: Option<&CodexService>,
    requests: Vec<CodexHeldRolloutRequest>,
) {
    for held in requests {
        let Some(service) = service else {
            refuse_unplaced(
                &held.thread_id,
                None,
                "the service whose rollout file stated it has ended",
            );
            continue;
        };
        let session_id = held.session_id;
        if let Some(exported) = held.into_exported(service) {
            push_exported_response(service, session_id, exported);
        }
    }
}

/// A launch's newest exported responses and the rollout requests it holds, each decided against
/// them. Two equal responses are two entries.
#[derive(Default)]
pub(crate) struct CodexRolloutDecisions {
    exported: VecDeque<CodexExportedIdentity>,
    held: VecDeque<CodexHeldRolloutRequest>,
}

impl CodexRolloutDecisions {
    /// Keeps each of `responses` an export carried that has a stamp, the oldest forgotten past
    /// the bound.
    pub(crate) fn remember_exported(&mut self, responses: Vec<CodexExportedIdentity>) {
        for response in responses {
            if response.observed_at_ms != 0 {
                remember(&mut self.exported, response, EXPORTED_RESPONSES_KEPT);
            }
        }
    }

    /// Takes the oldest exported response on `thread_id` with `counts` logged at or before
    /// `at_ms`, the stamp of a rollout record, which Codex writes only after it logs the response;
    /// answers whether one was kept. A thread's responses come one after another, and a file is
    /// read and its requests decided in order, so each entry is taken by its own record before a
    /// later one's.
    pub(crate) fn take_exported(
        &mut self,
        thread_id: &str,
        counts: &UsageAxisCounts,
        at_ms: u64,
    ) -> bool {
        let Some(index) = self.exported.iter().position(|exported| {
            exported.thread_id == thread_id
                && is_same_counts(&exported.counts, counts)
                && exported.observed_at_ms <= at_ms
        }) else {
            return false;
        };
        self.exported.remove(index);
        true
    }

    /// Takes `held`, whose record no exported response matched as it was read: priced at once
    /// where an export read so far carries a record later than its stamp, `newest_export_ms`,
    /// since every response logged by then was in an export already read or never will be; else
    /// held. Answers what is to be priced, the oldest held one included where the hold is full and
    /// no exported response matches it.
    pub(crate) fn hold(
        &mut self,
        held: CodexHeldRolloutRequest,
        newest_export_ms: Option<u64>,
    ) -> Option<CodexHeldRolloutRequest> {
        if newest_export_ms.is_some_and(|newest_ms| newest_ms > held.request.at_ms) {
            return Some(held);
        }
        let oldest = remember(&mut self.held, held, HELD_REQUESTS_KEPT)?;
        self.decide_one(oldest)
    }

    /// Decides each held request stamped before `newest_ms`, the newest record an export read
    /// carries; answers those to be priced.
    pub(crate) fn decide_stamped_before(&mut self, newest_ms: u64) -> Vec<CodexHeldRolloutRequest> {
        self.decide(|held| held.request.at_ms < newest_ms)
    }

    /// Decides each held request no export can still arrive with by `now`; answers those to be
    /// priced.
    pub(crate) fn decide_due(&mut self, now: Instant) -> Vec<CodexHeldRolloutRequest> {
        self.decide(|held| held.due_at <= now)
    }

    /// Decides each held request filed on `session_id`; answers those to be priced.
    pub(crate) fn decide_session(&mut self, session_id: SessionId) -> Vec<CodexHeldRolloutRequest> {
        self.decide(|held| held.session_id == session_id)
    }

    /// Decides every held request; answers those to be priced.
    pub(crate) fn decide_all(&mut self) -> Vec<CodexHeldRolloutRequest> {
        self.decide(|_held| true)
    }

    /// When the first held request falls due, if one is held.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.held.iter().map(|held| held.due_at).min()
    }

    // Decides each held request `is_picked` picks, in the order held; answers those no exported
    // response matches.
    fn decide(
        &mut self,
        is_picked: impl Fn(&CodexHeldRolloutRequest) -> bool,
    ) -> Vec<CodexHeldRolloutRequest> {
        let mut priced = Vec::new();
        let mut kept = VecDeque::with_capacity(self.held.len());
        for held in std::mem::take(&mut self.held) {
            if !is_picked(&held) {
                kept.push_back(held);
                continue;
            }
            priced.extend(self.decide_one(held));
        }
        self.held = kept;
        priced
    }

    // `held` where no exported response matches it, else `None`, the match taken.
    fn decide_one(&mut self, held: CodexHeldRolloutRequest) -> Option<CodexHeldRolloutRequest> {
        let request = &held.request;
        if self.take_exported(&held.thread_id, &request.counts, request.at_ms) {
            tracing::debug!(
                conversation_id = held.thread_id.as_str(),
                "a held codex rollout record an export carried is passed over"
            );
            return None;
        }
        Some(held)
    }
}

#[cfg(test)]
mod tests;
