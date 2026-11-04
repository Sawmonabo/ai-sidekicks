//! `mcp.registry.search`, answered from the public MCP Registry: no reply in time is refused
//! `provider.timeout`, and any other failure to read a page `provider.unavailable`.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::mcp::governance::McpRegistrySearch;
use sidekicks_contracts::mcp::server::requests::McpRegistrySearchRequest;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_mcp::registry_search::McpRegistryClient;

/// Registers `mcp.registry.search` over `client`. Fails the start when it is already registered.
pub(super) fn register_request_methods(
    registry: &mut MethodRegistryBuilder,
    client: Arc<McpRegistryClient>,
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
    )
}
