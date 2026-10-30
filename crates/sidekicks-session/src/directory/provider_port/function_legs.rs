//! The function legs each of a session's provider processes is handed: the MCP status producer
//! of its own leg, which attributes the servers it reports at the session's project root, or for
//! a session in no root among the provider's root-free bindings. One composer serves a session's
//! opening, each relaunch a driver starts on its own and each relaunch that keeps its binding.

use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_mcp::status::normalizer::{McpSessionAttribution, open_mcp_leg_status_producer};
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;

use super::{SessionDirectoryProviderPort, SessionDirectoryProviderPortError};
use crate::run::stored_leg::read_session_leg;

/// Hands each binding a session's process runs under the function legs bound to it.
pub type SessionFunctionLegsFor =
    Arc<dyn Fn(&RuntimeBindingId) -> ResumeFunctionLegs + Send + Sync>;

impl SessionDirectoryProviderPort {
    /// The function legs of each binding of `session_id`, whose processes run on `provider`: a
    /// status producer per binding, opened on the tracker when the binding's legs are composed. A
    /// session in no project with an attached folder (a chat among them) attributes at no root,
    /// among the provider's root-free bindings. Fails as the root's read fails, and when the
    /// stored root is no path the wire carries.
    pub(super) async fn compose_function_legs(
        &self,
        session_id: SessionId,
        provider: ProviderId,
    ) -> Result<SessionFunctionLegsFor, SessionDirectoryProviderPortError> {
        let root = self
            .deps
            .project_records
            .read_project_root_of_session(session_id)
            .await?;
        let attribution = McpSessionAttribution::new(
            Arc::clone(&self.deps.mcp_attribution),
            provider,
            root.as_ref(),
        )
        .map_err(SessionDirectoryProviderPortError::McpRootPath)?;
        let tracker = Arc::clone(&self.deps.mcp_status);
        Ok(Arc::new(move |binding_id| ResumeFunctionLegs {
            on_mcp_server_status: Some(open_mcp_leg_status_producer(
                &tracker,
                attribution.clone(),
                session_id,
                binding_id.clone(),
            )),
        }))
    }

    /// Opens the cursor of `binding_id`, a relaunch's binding, and answers its function legs,
    /// composed for the provider of the session's leg; a session with no leg yet opens nothing and
    /// answers no producer. Fails as the reads or the cursor's open fail, and then opens no leg.
    pub(super) async fn open_relaunch(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<ResumeFunctionLegs, SessionDirectoryProviderPortError> {
        let function_legs_for = self.compose_session_function_legs(session_id).await?;
        self.deps
            .binding_cursors
            .open_driver_relaunch(session_id, binding_id.clone())
            .await?;
        Ok(function_legs_for
            .map(|function_legs_for| function_legs_for(&binding_id))
            .unwrap_or_default())
    }

    /// Answers the function legs of `binding_id`, the process a relaunch that keeps the session's
    /// binding starts, composed for the provider of the session's leg, with no cursor opened: a
    /// fresh status producer, never the ended process's. A session with no leg yet answers no
    /// producer. Fails as the reads fail.
    pub(super) async fn compose_relaunch_legs(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<ResumeFunctionLegs, SessionDirectoryProviderPortError> {
        Ok(self
            .compose_session_function_legs(session_id)
            .await?
            .map(|function_legs_for| function_legs_for(&binding_id))
            .unwrap_or_default())
    }

    // The function legs of `session_id`'s bindings, composed for the provider of its leg; `None`
    // for a session with no leg yet.
    async fn compose_session_function_legs(
        &self,
        session_id: SessionId,
    ) -> Result<Option<SessionFunctionLegsFor>, SessionDirectoryProviderPortError> {
        match read_session_leg(&self.deps.pool, session_id).await? {
            Some(leg) => Ok(Some(
                self.compose_function_legs(session_id, leg.provider_name)
                    .await?,
            )),
            None => Ok(None),
        }
    }
}
