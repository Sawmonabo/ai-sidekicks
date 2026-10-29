//! The compaction limit Codex resolved for one turn, read from the trace line it logs after each
//! model request when its log is JSON: `post sampling token usage`, whose
//! `auto_compact_scope_limit` member is the limit's debug text, `Some(<tokens>)`.

use serde::Deserialize;

/// The message of the trace line that carries the resolved limit.
const POST_SAMPLING_MESSAGE: &str = "post sampling token usage";

// The members of one JSON log line the reading uses.
#[derive(Deserialize)]
struct LogLine {
    fields: Option<LogFields>,
}

#[derive(Deserialize)]
struct LogFields {
    message: Option<String>,
    turn_id: Option<String>,
    auto_compact_scope_limit: Option<String>,
}

/// The limit one turn's trace line reports: the turn, and its limit in tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CodexTurnLimit {
    /// The turn the line is for.
    pub(super) turn_id: String,
    /// The compaction limit Codex resolved for it, in tokens.
    pub(super) limit_tokens: u64,
}

/// The limit one stderr line reports; `None` for any other line or a turn whose limit Codex left
/// unset.
pub(super) fn read_codex_turn_limit(line: &str) -> Option<CodexTurnLimit> {
    let fields = serde_json::from_str::<LogLine>(line).ok()?.fields?;
    if fields.message.as_deref() != Some(POST_SAMPLING_MESSAGE) {
        return None;
    }
    let limit_tokens = fields
        .auto_compact_scope_limit?
        .strip_prefix("Some(")?
        .strip_suffix(')')?
        .parse()
        .ok()?;
    Some(CodexTurnLimit {
        turn_id: fields.turn_id?,
        limit_tokens,
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{CodexTurnLimit, read_codex_turn_limit};

    /// A trace line in the form Codex's app-server writes with `LOG_FORMAT=json`.
    const TRACE_LINE: &str = r#"{"timestamp":"2026-10-21T07:58:12.418305Z","level":"TRACE","fields":{"message":"post sampling token usage","turn_id":"019a-turn","total_usage_tokens":9312,"auto_compact_scope_tokens":9312,"auto_compact_scope_limit":"Some(244800)","auto_compact_limit_scope":"Some(Total)","auto_compact_window_prefill_tokens":"None","full_context_window_limit":"Some(258400)","full_context_window_limit_reached":false,"token_limit_reached":false,"model_needs_follow_up":false,"has_pending_input":false,"needs_follow_up":false},"target":"codex_core::session::turn","span":{"name":"run_turn"}}"#;

    // The line's turn and limit are read; an unset limit and a line of another message read none.
    #[rstest]
    #[case::limit(TRACE_LINE, Some(("019a-turn", 244_800)))]
    #[case::unset(
        r#"{"fields":{"message":"post sampling token usage","turn_id":"t","auto_compact_scope_limit":"None"}}"#,
        None
    )]
    #[case::other_message(
        r#"{"fields":{"message":"post sampling token estimate","turn_id":"t","auto_compact_scope_limit":"Some(5)"}}"#,
        None
    )]
    fn reads_the_turn_and_its_limit(#[case] line: &str, #[case] limit: Option<(&str, u64)>) {
        let expected = limit.map(|(turn_id, limit_tokens)| CodexTurnLimit {
            turn_id: turn_id.to_owned(),
            limit_tokens,
        });
        assert_eq!(read_codex_turn_limit(line), expected);
    }
}
