//! Deleting Codex's own copy of a session's conversations, each on the service of the home that
//! holds it, the switching home or its account's, and the session's helper role files. Codex
//! refuses to delete a conversation a fork still builds on, so they go newest first, as the daemon
//! lists them. Each is let go before its delete, and a delete Codex does not answer in time
//! restarts its service, which stays wedged on that conversation otherwise.

use std::path::Path;
use std::time::Duration;

use sidekicks_std::elapsed::elapsed_ms_since;
use sidekicks_std::error_description::describe_error;
use tokio::time::Instant;

use crate::driver::codex::app_server_protocol::ThreadDeleteParams;
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::helper_roles::remove_codex_helper_roles;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{PurgeSessionParams, SessionConversation};

/// Codex's request that deletes a stored conversation.
const CODEX_THREAD_DELETE_METHOD: &str = "thread/delete";

/// How long a conversation's `thread/delete` may wait for Codex's answer before the purge fails
/// and restarts the service.
const CODEX_THREAD_DELETE_TIMEOUT: Duration = Duration::from_secs(60);

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
/// service of the home its binding's recovery data names, started within `start_bound` where it
/// is not running, and the session's role files under `roles_folder`. Each conversation is let go
/// first; a delete unanswered within [`CODEX_THREAD_DELETE_TIMEOUT`] fails and has its service
/// restarted. Fails with every step that failed.
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
    conversation: &SessionConversation,
) -> Result<(), DriverError> {
    let service = services
        .service_for_conversation(
            &conversation.provider_account_id,
            CodexConversationHome::read(&conversation.runtime_metadata),
        )
        .await?;
    service.ensure_started(start_bound).await?;
    let thread_id = &conversation.resume_handle;
    let_go_codex_thread(&service, thread_id).await;
    let began = Instant::now();
    let deleted = service
        .connection()?
        .request_within(
            CODEX_THREAD_DELETE_METHOD,
            &ThreadDeleteParams {
                thread_id: thread_id.clone(),
            },
            CODEX_THREAD_DELETE_TIMEOUT,
        )
        .await;
    tracing::debug!(
        thread_id = %thread_id,
        elapsed_ms = elapsed_ms_since(began).get(),
        "a codex conversation's delete ended"
    );
    if let Err(CodexError::Unanswered {
        cause: CodexUnansweredCause::Deadline { .. },
        ..
    }) = &deleted
    {
        service.request_planned_restart();
    }
    deleted?;
    Ok(())
}

impl From<CodexPurgeFailed> for DriverError {
    fn from(error: CodexPurgeFailed) -> Self {
        Self::Internal(Box::new(error))
    }
}

#[cfg(test)]
mod tests;
