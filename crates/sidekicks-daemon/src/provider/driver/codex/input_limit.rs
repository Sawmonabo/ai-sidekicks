//! Reads Codex's refusal of a message longer than its input limit into the daemon's
//! `session.message.tooLarge`. Codex answers a `turn/start`, `turn/steer`, `thread/queue/add` or
//! `review/start` whose text passes its limit with `-32602` and a typed `data` naming the limit and
//! the length, both in characters, and starts nothing.

use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::SessionMessageTooLargeDetails;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};

/// The JSON-RPC code Codex answers a request whose params it refuses.
const CODEX_INVALID_PARAMS_CODE: i64 = -32602;

/// The `data.input_error_code` Codex gives a message past its input limit.
const CODEX_INPUT_TOO_LARGE: &str = "input_too_large";

/// The `session.message.tooLarge` refusal for a Codex JSON-RPC error object that refuses a message
/// as longer than Codex's input limit, its `data.fields` the limit and the length; `None` for any
/// other error, which the caller handles as it would without this reading.
#[expect(
    dead_code,
    reason = "the Codex driver's turn start, steer and queued message calls read their error here"
)]
pub(crate) fn message_too_large_refusal(error: &Value) -> Option<DomainError> {
    if error.get("code").and_then(Value::as_i64) != Some(CODEX_INVALID_PARAMS_CODE) {
        return None;
    }
    let data = error.get("data")?;
    if data.get("input_error_code").and_then(Value::as_str) != Some(CODEX_INPUT_TOO_LARGE) {
        return None;
    }
    let characters = |member: &str| {
        data.get(member)
            .and_then(Value::as_u64)
            .and_then(SafeInt::<1>::new)
    };
    let details = SessionMessageTooLargeDetails {
        limit: characters("max_chars")?,
        observed: characters("actual_chars")?,
    };
    Some(
        DomainError::new(
            "The message is longer than the provider takes in one message",
            RefusalCode::SessionMessageTooLarge,
            DomainErrorJsonRpcCode::InternalError,
        )
        .with_detail(details),
    )
}
