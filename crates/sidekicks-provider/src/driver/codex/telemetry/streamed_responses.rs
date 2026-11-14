//! The responses a copy's stream filed, by thread, kept until the export's twin claims one, so a
//! copy's request is not counted twice.

use std::collections::VecDeque;

use crate::usage_delta_accountant::{UsageAxisCounts, is_same_counts};

/// How many filed responses one copy keeps unclaimed; past it the oldest is pushed out.
const STREAMED_RESPONSES_KEPT: usize = 256;

/// The responses one copy's stream filed, oldest first, each by its thread and counts. A cache: an
/// entry pushed out only counts its twin again.
#[derive(Default)]
pub(crate) struct CodexStreamedResponses {
    stated: VecDeque<(String, UsageAxisCounts)>,
}

impl CodexStreamedResponses {
    /// Keeps a response the copy's stream filed on `thread_id` with `counts` for its export's
    /// twin; the oldest is pushed out once the ledger is full.
    pub(crate) fn record(&mut self, thread_id: &str, counts: UsageAxisCounts) {
        if self.stated.len() >= STREAMED_RESPONSES_KEPT
            && let Some((pushed_out, _counts)) = self.stated.pop_front()
        {
            tracing::debug!(
                thread_id = pushed_out.as_str(),
                "a codex copy's filed responses are full; the oldest is let go unclaimed"
            );
        }
        self.stated.push_back((thread_id.to_owned(), counts));
    }

    /// Takes the oldest response filed on `thread_id` whose six counts equal `counts`, an absent
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
