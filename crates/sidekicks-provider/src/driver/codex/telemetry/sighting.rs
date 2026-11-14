//! What one sighting of a Codex model request carries for the usage record, which prices the
//! request once however many of its stream frame, export record and rollout line arrive, in any
//! order. The three share no id, so their key is what each states alike: the request's thread and
//! its six counts, an absent count reading as zero. The export alone names the model and tier, so
//! neither is in the key; a rollout line also carries its `response_id`, which passes over the
//! line read a second time.

use sidekicks_contracts::event::usage::{UsageSighting, UsageSightingSource};
use sidekicks_contracts::wire::text::BoundedText;

use crate::usage_delta_accountant::UsageAxisCounts;

/// The sighting by `source` of the request on `thread_id` with `counts`, with `response_id` where
/// the source names it; `None`, logged, for a thread id too long for the key, which is then
/// priced on its own.
pub(crate) fn compose_codex_sighting(
    source: UsageSightingSource,
    thread_id: &str,
    counts: &UsageAxisCounts,
    response_id: Option<&str>,
) -> Option<UsageSighting> {
    let count = |count: Option<u64>| count.unwrap_or(0);
    let match_key = BoundedText::new(format!(
        "{thread_id}:{}:{}:{}:{}:{}:{}",
        count(counts.input),
        count(counts.cached_input),
        count(counts.cache_write_input),
        count(counts.output),
        count(counts.reasoning_output),
        count(counts.total),
    ));
    let Some(match_key) = match_key else {
        tracing::warn!(
            "a codex request's thread id is too long for its sighting; it is priced with none"
        );
        return None;
    };
    Some(UsageSighting {
        match_key,
        source,
        sighting_key: response_id.and_then(|id| BoundedText::new(id.to_owned())),
    })
}
