//! The responses a session's stream stated, by thread, kept while its launch exports until the
//! export's twin claims one, and the exported ones it priced before its stream stated them, kept
//! until the stream's late twin is matched to one or their turn is long settled, so no request
//! is counted twice.

use std::collections::VecDeque;

use strum::VariantArray as _;
use tokio::time::Instant;

use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;
use crate::pricing::export_status::INTERVALS_WAITED;
use crate::usage_delta_accountant::{UsageAxisCounts, UsageTokenAxis};

/// How many stated responses one session keeps unclaimed, and how many priced exported ones it
/// keeps unmatched; past either the oldest is pushed out.
pub(crate) const STREAMED_RESPONSES_KEPT: usize = 256;

/// The responses one session's stream stated and the exported ones it priced first, oldest first,
/// each by its thread and counts. A cache: an entry pushed out only counts its twin again.
#[derive(Default)]
pub(crate) struct CodexStreamedResponses {
    // Whether the launch exports, so an export's twin can arrive; while it does not, nothing is
    // kept.
    is_exporting: bool,
    stated: VecDeque<(String, UsageAxisCounts)>,
    priced: VecDeque<CodexPricedResponse>,
}

// An exported response priced before the stream stated it: its thread, the turn it was filed on
// and its counts, kept until two export intervals after the later of its pricing and its turn's
// settle, when every late twin has arrived; `expires_at` is `None` while its turn is live.
struct CodexPricedResponse {
    thread_id: String,
    turn_id: Option<String>,
    counts: UsageAxisCounts,
    expires_at: Option<Instant>,
}

impl CodexStreamedResponses {
    /// Sets whether the session's launch exports; a launch that does not keeps no stated
    /// response, since no export's twin will claim one.
    pub(crate) fn set_exporting(&mut self, is_exporting: bool) {
        self.is_exporting = is_exporting;
    }

    /// Takes a response the stream stated on `thread_id` with `counts`: answers `false`, keeping
    /// nothing, where it is the late twin of an exported response already priced, which it is
    /// matched to; else keeps it for its export's twin, while the launch exports, and answers
    /// `true`. The oldest is pushed out once the ledger is full.
    pub(crate) fn record(&mut self, thread_id: &str, counts: UsageAxisCounts) -> bool {
        let now = Instant::now();
        self.priced
            .retain(|priced| priced.expires_at.is_none_or(|expires_at| expires_at > now));
        if let Some(index) = self.priced.iter().position(|priced| {
            priced.thread_id == thread_id && is_same_counts(&priced.counts, &counts)
        }) {
            self.priced.remove(index);
            return false;
        }
        if self.is_exporting {
            if self.stated.len() >= STREAMED_RESPONSES_KEPT
                && let Some((pushed_out, _counts)) = self.stated.pop_front()
            {
                tracing::debug!(
                    thread_id = pushed_out.as_str(),
                    "a codex session's stated responses are full; the oldest is let go unclaimed"
                );
            }
            self.stated.push_back((thread_id.to_owned(), counts));
        }
        true
    }

    /// Keeps an exported response on `thread_id` with `counts`, filed on `turn_id`, that was
    /// priced before the stream stated it, so the stream's late twin is matched to it and never
    /// counted again; `is_settled` says its turn already settled, or it was filed on none.
    pub(crate) fn record_priced(
        &mut self,
        thread_id: &str,
        turn_id: Option<&str>,
        counts: UsageAxisCounts,
        is_settled: bool,
    ) {
        if self.priced.len() >= STREAMED_RESPONSES_KEPT
            && let Some(pushed_out) = self.priced.pop_front()
        {
            tracing::debug!(
                thread_id = pushed_out.thread_id.as_str(),
                "a codex session's priced responses are full; the oldest is let go unmatched"
            );
        }
        let expires_at = (is_settled || turn_id.is_none()).then(expiry);
        self.priced.push_back(CodexPricedResponse {
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.map(str::to_owned),
            counts,
            expires_at,
        });
    }

    /// The turn `turn_id` on `thread_id` settled or went: each priced response filed on it
    /// expires two export intervals from now.
    pub(crate) fn turn_settled(&mut self, thread_id: &str, turn_id: &str) {
        for priced in &mut self.priced {
            if priced.expires_at.is_none()
                && priced.thread_id == thread_id
                && priced.turn_id.as_deref() == Some(turn_id)
            {
                priced.expires_at = Some(expiry());
            }
        }
    }

    /// Takes the oldest response stated on `thread_id` whose six counts equal `counts`, an absent
    /// count reading as zero; answers whether one was there. Two equal responses are two entries.
    pub(crate) fn claim(&mut self, thread_id: &str, counts: &UsageAxisCounts) -> bool {
        let Some(index) = self.stated.iter().position(|(kept_thread, kept_counts)| {
            kept_thread == thread_id && is_same_counts(kept_counts, counts)
        }) else {
            return false;
        };
        self.stated.remove(index);
        true
    }
}

// When a priced response settled now expires: once every late twin has had two export intervals.
fn expiry() -> Instant {
    Instant::now() + CODEX_EXPORT_INTERVAL * INTERVALS_WAITED
}

// Whether `left` and `right` carry the same count on every axis, an absent count reading as zero.
fn is_same_counts(left: &UsageAxisCounts, right: &UsageAxisCounts) -> bool {
    UsageTokenAxis::VARIANTS
        .iter()
        .all(|&axis| left.get(axis).unwrap_or(0) == right.get(axis).unwrap_or(0))
}
