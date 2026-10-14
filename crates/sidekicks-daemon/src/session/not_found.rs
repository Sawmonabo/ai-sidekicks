//! The one `session.not_found` refusal a session's create, conversion, changes and reads raise for
//! an id this daemon holds no session under.

use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;

use crate::ipc::domain_error::DomainError;

/// The refusal of `session_id`, which names no session this daemon holds; the id goes out as the
/// reply's `sessionId` field.
pub(crate) fn session_not_found(session_id: &SessionId) -> DomainError {
    let fields: Map<String, Value> = [(
        "sessionId".to_owned(),
        Value::String(session_id.as_str().to_owned()),
    )]
    .into_iter()
    .collect();
    DomainError::session_not_found("This daemon holds no such session.", Some(fields))
}
