//! Deleting Codex's own copy of a session's conversations, each on the service of the account home
//! it ran in, and the session's helper role files. Codex refuses to delete a conversation a fork
//! still builds on, so they go newest first, as the daemon lists them. The person's own Codex
//! folder keeps its conversations.

use std::path::Path;
use std::time::Duration;

use crate::error_description::describe_error;
use crate::provider::driver::codex::app_server_protocol::ThreadDeleteParams;
use crate::provider::driver::codex::service::home::CodexHomeKind;
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::session::helper_roles::remove_codex_helper_roles;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::session_control::{PurgeSessionParams, PurgedConversation};

/// Codex's request that deletes a stored conversation.
const CODEX_THREAD_DELETE_METHOD: &str = "thread/delete";

/// Every step of a purge that failed, each tried before the purge answered, so one refusal leaves
/// nothing else behind.
#[derive(Debug, thiserror::Error)]
#[error(
    "{} of the session's Codex conversations or role files were not deleted: {}",
    .failures.len(),
    .failures.iter().map(|failure| describe_error(failure)).collect::<Vec<_>>().join("; ")
)]
pub(crate) struct CodexPurgeFailed {
    /// Each failure, in the order the purge met it.
    pub(crate) failures: Vec<DriverError>,
}

/// Deletes every conversation the session opened with `thread/delete`, newest first, on the
/// service of its account's home, started within `start_bound` where it is not running, and the
/// session's role files under `roles_folder`. A conversation in the person's own Codex folder is
/// kept. Fails with every step that failed.
pub(crate) async fn purge_codex_conversations(
    services: &CodexServiceRegistry,
    roles_folder: &Path,
    start_bound: Duration,
    params: &PurgeSessionParams,
) -> Result<(), CodexPurgeFailed> {
    let mut failures = Vec::new();
    if let Err(error) = remove_codex_helper_roles(roles_folder, params.session_id).await {
        failures.push(error);
    }
    for conversation in &params.conversations {
        if let Err(error) = delete_conversation(services, start_bound, conversation).await {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CodexPurgeFailed { failures })
    }
}

async fn delete_conversation(
    services: &CodexServiceRegistry,
    start_bound: Duration,
    conversation: &PurgedConversation,
) -> Result<(), DriverError> {
    let service = services
        .service_for(conversation.provider_account_id.as_ref())
        .await?;
    if service.home().kind != CodexHomeKind::Account {
        return Ok(());
    }
    service.ensure_started(start_bound).await?;
    service
        .connection()?
        .request(
            CODEX_THREAD_DELETE_METHOD,
            &ThreadDeleteParams {
                thread_id: conversation.resume_handle.clone(),
            },
        )
        .await?;
    Ok(())
}

impl From<CodexPurgeFailed> for DriverError {
    fn from(error: CodexPurgeFailed) -> Self {
        Self::Internal(Box::new(error))
    }
}
