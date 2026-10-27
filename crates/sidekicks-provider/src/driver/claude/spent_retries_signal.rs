//! Reads Claude Code's `api_retry` frame, or `api_error`, which Claude Code maps onto it, for the
//! end of its own retry ladder. Claude Code retries a rate limit or an overload itself; when the
//! final announced retry fails too, the turn ends with the provider not answering. That is the
//! spent-retries cause, never a spent plan allowance: a plan limit is not retried, so no retry
//! frame announces one.

use serde_json::Value;
use sidekicks_contracts::provider::driver::usage_limit::{
    ProviderSpentRetriesSignal, RetriesExhausted,
};

use crate::driver::claude::turn_evidence::is_positive_finite_number;

// The `error` members Claude Code retries until its ladder is spent.
const CLAUDE_RETRIED_ERRORS: [&str; 2] = ["rate_limit", "overloaded"];

/// Classifies Claude Code's final announced retry of a rate limit or an overload as the
/// spent-retries cause, or `None`. It reads only `type`, `subtype`, the `error` member and the
/// ladder members, so an unfamiliar shape gives `None`; `frame` is untrusted provider output.
pub(crate) fn classify_claude_spent_retries(frame: &Value) -> Option<ProviderSpentRetriesSignal> {
    let frame = frame.as_object()?;
    // `error_status` is never read: a bare `429` says nothing the typed member does not.
    if frame.get("type").and_then(Value::as_str) != Some("system")
        || !matches!(
            frame.get("subtype").and_then(Value::as_str),
            Some("api_retry" | "api_error")
        )
        || !frame
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| CLAUDE_RETRIED_ERRORS.contains(&error))
    {
        return None;
    }
    // Only the final announced retry counts; a mid-ladder frame is the provider still retrying.
    // The positive reads also refuse `max_retries: 0`, which announces no ladder. A final attempt
    // that then succeeds still classifies, so the consumer correlates it with the turn's end.
    let attempt = frame
        .get("attempt")
        .filter(|value| is_positive_finite_number(value))?;
    let max_retries = frame
        .get("max_retries")
        .filter(|value| is_positive_finite_number(value))?;
    if attempt.as_f64()? < max_retries.as_f64()? {
        return None;
    }
    Some(ProviderSpentRetriesSignal {
        cause: RetriesExhausted::RetriesExhausted,
    })
}
