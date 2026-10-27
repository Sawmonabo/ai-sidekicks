//! The reading a `thread/tokenUsage/updated` frame carries: the conversation's cumulative counts,
//! the turn's own figure beside them, and the turn they belong to, for the usage accountant.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::codex::transport::connection::read_codex_object;
use crate::usage_delta_accountant::{CumulativeUsageReading, UsageAxisCounts};

/// The frame's members the reading takes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageFrame {
    thread_id: Option<String>,
    turn_id: Option<String>,
    token_usage: Option<TokenUsage>,
}

/// The conversation's cumulative counts and the latest turn's.
#[derive(Deserialize)]
struct TokenUsage {
    total: Option<TokenCounts>,
    last: Option<TokenCounts>,
}

/// One set of counts, each axis as Codex names it.
#[derive(Deserialize)]
#[expect(
    clippy::struct_field_names,
    reason = "each count is named as Codex names it"
)]
#[serde(rename_all = "camelCase")]
struct TokenCounts {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

impl From<TokenCounts> for UsageAxisCounts {
    fn from(counts: TokenCounts) -> Self {
        Self {
            input: counts.input_tokens,
            cached_input: counts.cached_input_tokens,
            cache_write_input: counts.cache_write_input_tokens,
            output: counts.output_tokens,
            reasoning_output: counts.reasoning_output_tokens,
            total: counts.total_tokens,
        }
    }
}

/// The cumulative reading a `thread/tokenUsage/updated` frame's `params` carry, or `None` when it
/// names no conversation or carries no cumulative counts.
pub(crate) fn read_codex_token_usage(params: &RawValue) -> Option<CumulativeUsageReading> {
    let frame = read_codex_object::<TokenUsageFrame>(params.get())?;
    let thread_id = frame.thread_id.filter(|thread_id| !thread_id.is_empty())?;
    let usage = frame.token_usage?;
    Some(CumulativeUsageReading {
        thread_id,
        named_turn_id: frame.turn_id.filter(|turn_id| !turn_id.is_empty()),
        cumulative: usage.total?.into(),
        declared_per_turn: usage.last.map(UsageAxisCounts::from),
    })
}
