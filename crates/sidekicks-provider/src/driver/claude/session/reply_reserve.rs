//! Claude Code's reply reserve and constant, which no request reports. Its compaction point is the
//! window less the reply reserve (the model's maximum reply, capped) and a constant, so two context
//! reads on one known window, the second with a maximum reply below the reserve, give both: the
//! second read's point moves by the reserve less that maximum.

use serde_json::value::RawValue;
use serde_json::{Map, Value};

use crate::driver::claude::session::transport::readings::ClaudeReplyReserveReads;
use crate::record_readers::{read_count, read_non_empty_string};

/// The window both reads set: the smallest window Claude Code takes for the key.
pub(crate) const CLAUDE_RESERVE_READ_WINDOW_TOKENS: u64 = 100_000;

/// The maximum reply the second read sets, below any model's reply reserve.
pub(crate) const CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS: u64 = 1_000;

/// The environment key that sets the window Claude Code compacts on.
pub(crate) const CLAUDE_AUTO_COMPACT_WINDOW_KEY: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/// The environment key that caps every reply; set only in the creation-time control process.
pub(crate) const CLAUDE_MAX_OUTPUT_TOKENS_KEY: &str = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

/// The reply reserve and constant Claude Code subtracts from the window for the session's model,
/// in tokens, or why they could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeReplyReserve {
    /// Both were read.
    Read {
        /// The model the reads ran on, as Claude Code's context report names it.
        model: String,
        /// The reply reserve.
        reply_reserve_tokens: u64,
        /// The constant.
        constant_tokens: u64,
    },
    /// They could not be read.
    Unread {
        /// Why, in words.
        reason: String,
    },
}

/// Derives the reply reserve and constant from the two reads. Unread when Claude Code refused a
/// request on the way, when a reply lacks the window or the compaction point, when either read is
/// not on the window key's window (Claude Code drops a key it does not take), or when the maximum
/// reply did not move the point.
pub(crate) fn derive_claude_reply_reserve(
    requested_model: &str,
    reads: &ClaudeReplyReserveReads,
) -> ClaudeReplyReserve {
    let (window_only, with_maximum_output) = match reads {
        ClaudeReplyReserveReads::Refused { detail } => {
            return unread(format!("Claude Code refused a context read: {detail}"));
        }
        ClaudeReplyReserveReads::Read {
            window_only,
            with_maximum_output,
        } => (
            read_context_reply(window_only.as_deref()),
            read_context_reply(with_maximum_output.as_deref()),
        ),
    };
    let window = CLAUDE_RESERVE_READ_WINDOW_TOKENS;
    let maximum_output = CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS;
    let (Some(window_only_point), Some(capped_point)) = (
        read_count(&window_only, "autoCompactThreshold"),
        read_count(&with_maximum_output, "autoCompactThreshold"),
    ) else {
        return unread("Claude Code's context report carried no compaction point.".to_owned());
    };
    if read_count(&window_only, "maxTokens") != Some(window)
        || read_count(&with_maximum_output, "maxTokens") != Some(window)
    {
        return unread("Claude Code did not take the window key.".to_owned());
    }
    let constant_tokens = (window - maximum_output).checked_sub(capped_point);
    let (Some(constant_tokens), true) = (constant_tokens, capped_point > window_only_point) else {
        return unread("Claude Code did not take the maximum reply key.".to_owned());
    };
    ClaudeReplyReserve::Read {
        model: read_non_empty_string(&window_only, "model")
            .unwrap_or(requested_model)
            .to_owned(),
        reply_reserve_tokens: maximum_output + capped_point - window_only_point,
        constant_tokens,
    }
}

fn unread(reason: String) -> ClaudeReplyReserve {
    ClaudeReplyReserve::Unread { reason }
}

/// A context reply's members; a reply that is no object reads as one with none.
pub(super) fn read_context_reply(reply: Option<&RawValue>) -> Map<String, Value> {
    reply
        .and_then(|reply| serde_json::from_str(reply.get()).ok())
        .unwrap_or_default()
}
