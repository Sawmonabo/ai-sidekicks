//! Deleting Codex's own copy of a session's conversations, each on the service of the home that
//! holds it, the switching home or its account's, and the session's helper role files. Codex
//! refuses to delete a conversation a fork still builds on, so they go newest first, as the daemon
//! lists them. Each is let go before its delete, and a delete Codex does not answer in time has its
//! service restarted, which stays wedged on that conversation otherwise; no purge sends a
//! conversation to that service until the restart ends.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::elapsed::elapsed_ms_since;
use sidekicks_std::error_description::describe_error;
use tokio::time::Instant;

use crate::driver::codex::app_server_protocol::ThreadDeleteParams;
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::helper_roles::remove_codex_helper_roles;
use crate::driver::codex::session::recovery::CodexServiceRecovery;
use crate::driver::codex::session::recovery::build_move::CodexServiceRestart;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::PurgeSessionParams;

/// Codex's request that deletes a stored conversation.
const CODEX_THREAD_DELETE_METHOD: &str = "thread/delete";

/// How long a conversation's `thread/delete` may wait for Codex's answer before the purge fails
/// and restarts the service.
const CODEX_THREAD_DELETE_TIMEOUT: Duration = Duration::from_secs(60);

/// What a purge restarts a service through when the service leaves a delete unanswered.
pub(crate) trait CodexServiceRestarts: Sync {
    /// Whether a restart of the service `service_id` is under way.
    fn is_restarting(&self, service_id: CodexServiceId) -> bool;

    /// Restarts `service` without waiting for it, joining a restart already under way.
    fn restart(&self, service: &Arc<CodexService>);
}

impl CodexServiceRestarts for Arc<CodexServiceRecovery> {
    fn is_restarting(&self, service_id: CodexServiceId) -> bool {
        CodexServiceRecovery::is_restarting(self, service_id)
    }

    fn restart(&self, service: &Arc<CodexService>) {
        self.request_restart(service, CodexServiceRestart::InPlace);
    }
}

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
/// first; a delete unanswered within [`CODEX_THREAD_DELETE_TIMEOUT`] fails and has `restarts`
/// restart its service, and a conversation on a service `restarts` is restarting fails unsent.
/// Fails with every step that failed.
pub(crate) async fn purge_codex_conversations(
    services: &CodexServiceRegistry,
    restarts: &dyn CodexServiceRestarts,
    roles_folder: &Path,
    start_bound: Duration,
    params: &PurgeSessionParams,
) -> Result<(), CodexPurgeFailed> {
    let mut failures = Vec::new();
    if let Err(error) = remove_codex_helper_roles(roles_folder, params.session_id).await {
        failures.push(error);
    }
    for conversation in &params.conversations {
        let service = match services
            .service_for_conversation(
                &conversation.provider_account_id,
                CodexConversationHome::read(&conversation.runtime_metadata),
            )
            .await
        {
            Ok(service) => service,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        let thread_id = &conversation.resume_handle;
        if restarts.is_restarting(service.id()) {
            failures.push(
                CodexError::Transport {
                    detail: format!(
                        "Codex conversation \"{thread_id}\" was not deleted: its service is \
                         restarting after a delete it did not answer."
                    ),
                    cause: None,
                }
                .into(),
            );
            continue;
        }
        if let Err(error) = delete_conversation(&service, start_bound, thread_id).await {
            if matches!(
                error,
                CodexError::Unanswered {
                    cause: CodexUnansweredCause::Deadline { .. },
                    ..
                }
            ) {
                restarts.restart(&service);
            }
            failures.push(error.into());
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CodexPurgeFailed { failures })
    }
}

async fn delete_conversation(
    service: &CodexService,
    start_bound: Duration,
    thread_id: &str,
) -> Result<(), CodexError> {
    service.ensure_started(start_bound).await?;
    let_go_codex_thread(service, thread_id).await;
    let began = Instant::now();
    let deleted = service
        .connection()?
        .request_within(
            CODEX_THREAD_DELETE_METHOD,
            &ThreadDeleteParams {
                thread_id: thread_id.to_owned(),
            },
            CODEX_THREAD_DELETE_TIMEOUT,
        )
        .await;
    tracing::debug!(
        thread_id,
        elapsed_ms = elapsed_ms_since(began).get(),
        "a codex conversation's delete ended"
    );
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
