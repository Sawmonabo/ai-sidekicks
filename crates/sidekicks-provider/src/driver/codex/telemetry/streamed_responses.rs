//! The responses a session's stream stated, by thread, kept until the export's twin claims one,
//! so no request is counted twice.

use std::collections::VecDeque;

use strum::VariantArray as _;

use crate::usage_delta_accountant::{UsageAxisCounts, UsageTokenAxis};

/// How many stated responses one session keeps unclaimed; past it the oldest is pushed out.
pub(crate) const STREAMED_RESPONSES_KEPT: usize = 256;

/// The responses one session's stream stated, oldest first, each by its thread and counts. A
/// cache: an entry pushed out only prices its export's twin again.
#[derive(Default)]
pub(crate) struct CodexStreamedResponses {
    stated: VecDeque<(String, UsageAxisCounts)>,
}

impl CodexStreamedResponses {
    /// Keeps a response the stream stated on `thread_id` with `counts`, the oldest pushed out and
    /// logged once the ledger is full.
    pub(crate) fn record(&mut self, thread_id: &str, counts: UsageAxisCounts) {
        if self.stated.len() >= STREAMED_RESPONSES_KEPT
            && let Some((pushed_out, _counts)) = self.stated.pop_front()
        {
            tracing::info!(
                thread_id = pushed_out.as_str(),
                "a codex session's stated responses are full; the oldest is let go unclaimed"
            );
        }
        self.stated.push_back((thread_id.to_owned(), counts));
    }

    /// Takes the oldest response stated on `thread_id` whose six counts equal `counts`, an absent
    /// count reading as zero; answers whether one was there. Two equal responses are two entries.
    #[expect(
        dead_code,
        reason = "the session's intake passes over each exported response it claims"
    )]
    pub(crate) fn claim(&mut self, thread_id: &str, counts: &UsageAxisCounts) -> bool {
        let Some(index) = self.stated.iter().position(|(stated_thread, stated)| {
            stated_thread == thread_id && is_same_counts(stated, counts)
        }) else {
            return false;
        };
        self.stated.remove(index);
        true
    }
}

// Whether `left` and `right` carry the same count on every axis, an absent count reading as zero.
#[expect(dead_code, reason = "the ledger's claim compares counts through it")]
fn is_same_counts(left: &UsageAxisCounts, right: &UsageAxisCounts) -> bool {
    UsageTokenAxis::VARIANTS
        .iter()
        .all(|&axis| left.get(axis).unwrap_or(0) == right.get(axis).unwrap_or(0))
}
