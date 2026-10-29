//! The refusals more than one of the session crate's services send.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;

/// `session.workingFolder.missing` for `session_id`, whose working folder is not in place, with
/// `message` saying what that stops; the session's id goes out as the refusal's detail.
pub(crate) fn working_folder_missing(session_id: &SessionId, message: &'static str) -> DomainError {
    DomainError::new(message, RefusalCode::SessionWorkingFolderMissing)
        .with_detail(json!({ "sessionId": session_id }))
}
