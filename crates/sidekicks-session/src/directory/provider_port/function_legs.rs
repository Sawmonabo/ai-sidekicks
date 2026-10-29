//! The function legs each of a session's provider processes is handed: the MCP status producer
//! of its own leg, which attributes the servers it reports at the session's project root. One
//! composer serves a session's opening and each relaunch a driver starts on its own.

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
    /// session in no project with an attached folder (a chat among them) has no root to attribute
    /// at, so its legs carry no producer. Fails as the root's read fails, and when the stored root
    /// is no path the wire carries.
    pub(super) async fn compose_function_legs(
        &self,
        session_id: SessionId,
        provider: ProviderId,
    ) -> Result<SessionFunctionLegsFor, SessionDirectoryProviderPortError> {
        let Some(root) = self
            .deps
            .project_records
            .read_project_root_of_session(session_id)
            .await?
        else {
            return Ok(Arc::new(|_| ResumeFunctionLegs::default()));
        };
        let attribution =
            McpSessionAttribution::new(Arc::clone(&self.deps.mcp_attribution), provider, &root)
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
        let function_legs_for = match read_session_leg(&self.deps.pool, session_id).await? {
            Some(leg) => Some(
                self.compose_function_legs(session_id, leg.provider_name)
                    .await?,
            ),
            None => None,
        };
        self.deps
            .binding_cursors
            .open_driver_relaunch(session_id, binding_id.clone())
            .await?;
        Ok(function_legs_for
            .map(|function_legs_for| function_legs_for(&binding_id))
            .unwrap_or_default())
    }
}
