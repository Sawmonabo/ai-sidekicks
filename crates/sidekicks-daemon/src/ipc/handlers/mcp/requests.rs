//! `mcp.registry.search`, answered from the public MCP Registry: no reply in time is refused
//! `provider.timeout`, and any other failure to read a page `provider.unavailable`; and the binding
//! edits `mcp.server.upsert` and `mcp.server.enabled.update`, answered by the mutation service.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::mcp::governance::{
    McpRegistrySearch, McpServerEnabledUpdate, McpServerUpsert,
};
use sidekicks_contracts::mcp::server::requests::{
    McpRegistrySearchRequest, McpServerEnabledUpdateRequest, McpServerUpsertRequest,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_mcp::mutation::service::McpMutationService;
use sidekicks_mcp::registry_search::McpRegistryClient;

/// Registers `mcp.registry.search` over `client`, and `mcp.server.upsert` and
/// `mcp.server.enabled.update` over `mutations`. Fails the start when one is already registered.
pub(super) fn register_request_methods(
    registry: &mut MethodRegistryBuilder,
    client: Arc<McpRegistryClient>,
    mutations: &Arc<McpMutationService>,
) -> Result<(), RegistrationError> {
    registry.register::<McpRegistrySearch, _>(
        move |request: McpRegistrySearchRequest, _context: HandlerContext| {
            let client = Arc::clone(&client);
            async move {
                client
                    .search(&request)
                    .await
                    .map_err(|error| HandlerError::Refused(DomainError::from(error)))
            }
            .boxed()
        },
    )?;
    let upserts = Arc::clone(mutations);
    registry.register::<McpServerUpsert, _>(
        move |request: McpServerUpsertRequest, _context: HandlerContext| {
            let mutations = Arc::clone(&upserts);
            async move {
                mutations
                    .upsert(request)
                    .await
                    .map_err(HandlerError::Refused)
            }
            .boxed()
        },
    )?;
    let switches = Arc::clone(mutations);
    registry.register::<McpServerEnabledUpdate, _>(
        move |request: McpServerEnabledUpdateRequest, _context: HandlerContext| {
            let mutations = Arc::clone(&switches);
            async move {
                mutations
                    .set_enabled(request)
                    .await
                    .map_err(HandlerError::Refused)
            }
            .boxed()
        },
    )
}
