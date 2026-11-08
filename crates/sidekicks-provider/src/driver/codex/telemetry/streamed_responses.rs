//! The responses a session's stream stated, by thread, kept until the export's twin claims one,
//! and the exported ones it priced before its stream stated them, kept until the stream's late
//! twin is matched to one, so no request is counted twice.

use std::collections::VecDeque;

use strum::VariantArray as _;

use crate::usage_delta_accountant::{UsageAxisCounts, UsageTokenAxis};

/// How many stated responses one session keeps unclaimed, and how many priced exported ones it
/// keeps unmatched; past either the oldest is pushed out.
pub(crate) const STREAMED_RESPONSES_KEPT: usize = 256;

/// The responses one session's stream stated and the exported ones it priced first, oldest first,
/// each by its thread and counts. A cache: an entry pushed out only counts its twin again.
#[derive(Default)]
pub(crate) struct CodexStreamedResponses {
    stated: VecDeque<(String, UsageAxisCounts)>,
    priced: VecDeque<(String, UsageAxisCounts)>,
}

impl CodexStreamedResponses {
    /// Takes a response the stream stated on `thread_id` with `counts`: answers `false`, keeping
    /// nothing, where it is the late twin of an exported response already priced, which it is
    /// matched to; else keeps it for its export's twin and answers `true`. The oldest is pushed
    /// out and logged once the ledger is full.
    pub(crate) fn record(&mut self, thread_id: &str, counts: UsageAxisCounts) -> bool {
        if take_matching(&mut self.priced, thread_id, &counts) {
            return false;
        }
        push_bounded(
            &mut self.stated,
            thread_id,
            counts,
            "a codex session's stated responses are full; the oldest is let go unclaimed",
        );
        true
    }

    /// Keeps an exported response on `thread_id` with `counts` that was priced before the stream
    /// stated it, so the stream's late twin is matched to it and never counted again.
    pub(crate) fn record_priced(&mut self, thread_id: &str, counts: UsageAxisCounts) {
        push_bounded(
            &mut self.priced,
            thread_id,
            counts,
            "a codex session's priced responses are full; the oldest is let go unmatched",
        );
    }

    /// Takes the oldest response stated on `thread_id` whose six counts equal `counts`, an absent
    /// count reading as zero; answers whether one was there. Two equal responses are two entries.
    pub(crate) fn claim(&mut self, thread_id: &str, counts: &UsageAxisCounts) -> bool {
        take_matching(&mut self.stated, thread_id, counts)
    }
}

// Pushes `thread_id`'s `counts` onto `kept`, the oldest pushed out and logged as `pushed_out`
// once `kept` is full.
fn push_bounded(
    kept: &mut VecDeque<(String, UsageAxisCounts)>,
    thread_id: &str,
    counts: UsageAxisCounts,
    pushed_out: &'static str,
) {
    if kept.len() >= STREAMED_RESPONSES_KEPT
        && let Some((pushed_out_thread, _counts)) = kept.pop_front()
    {
        tracing::info!(thread_id = pushed_out_thread.as_str(), "{pushed_out}");
    }
    kept.push_back((thread_id.to_owned(), counts));
}

// Takes the oldest entry of `kept` on `thread_id` whose counts equal `counts`; answers whether one
// was there.
fn take_matching(
    kept: &mut VecDeque<(String, UsageAxisCounts)>,
    thread_id: &str,
    counts: &UsageAxisCounts,
) -> bool {
    let Some(index) = kept.iter().position(|(kept_thread, kept_counts)| {
        kept_thread == thread_id && is_same_counts(kept_counts, counts)
    }) else {
        return false;
    };
    kept.remove(index);
    true
}

// Whether `left` and `right` carry the same count on every axis, an absent count reading as zero.
fn is_same_counts(left: &UsageAxisCounts, right: &UsageAxisCounts) -> bool {
    UsageTokenAxis::VARIANTS
        .iter()
        .all(|&axis| left.get(axis).unwrap_or(0) == right.get(axis).unwrap_or(0))
}
