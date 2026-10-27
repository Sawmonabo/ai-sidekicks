//! The one `session.notFound` refusal a session's create, conversion, changes and reads raise for
//! an id this daemon holds no session under.

use serde_json::json;
use sidekicks_contracts::session::id::SessionId;

use crate::domain_error::DomainError;

/// The refusal of `session_id`, which names no session this daemon holds; the id goes out as the
/// reply's `sessionId` field.
pub(crate) fn session_not_found(session_id: &SessionId) -> DomainError {
    DomainError::session_not_found(
        "This daemon holds no such session.",
        json!({ "sessionId": session_id }),
    )
}
