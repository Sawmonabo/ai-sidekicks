//! `mcp.server.list` and `mcp.server.read`, answered from the MCP server inventory: a binding the
//! inventory does not hold is refused by its code, and a source it could not read is a fault.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::mcp::governance::{McpServerList, McpServerRead};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::requests::{
    McpServerListRequest, McpServerListResponse, McpServerReadResponse,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_mcp::inventory_service::{McpInventoryError, McpInventoryService};

/// Registers `mcp.server.list` and `mcp.server.read` over `inventory`. Fails the start when one is
/// already registered.
pub(super) fn register_inventory_methods(
    registry: &mut MethodRegistryBuilder,
    inventory: &Arc<McpInventoryService>,
) -> Result<(), RegistrationError> {
    let list_inventory = Arc::clone(inventory);
    registry.register::<McpServerList, _>(
        move |request: McpServerListRequest, _context: HandlerContext| {
            let inventory = Arc::clone(&list_inventory);
            async move {
                let servers = inventory
                    .list(&request)
                    .await
                    .map_err(inventory_handler_error)?;
                Ok(McpServerListResponse { servers })
            }
            .boxed()
        },
    )?;
    let read_inventory = Arc::clone(inventory);
    registry.register::<McpServerRead, _>(
        move |binding: McpServerBindingRef, _context: HandlerContext| {
            let inventory = Arc::clone(&read_inventory);
            async move {
                let server = inventory
                    .read(&binding)
                    .await
                    .map_err(inventory_handler_error)?;
                Ok(McpServerReadResponse { server })
            }
            .boxed()
        },
    )
}

/// The reply to an inventory failure: a refusal by its code, every source that could not be read
/// a fault inside the daemon.
fn inventory_handler_error(error: McpInventoryError) -> HandlerError {
    match error {
        McpInventoryError::Refused(refusal) => HandlerError::Refused(DomainError::from(*refusal)),
        fault @ (McpInventoryError::Projects(_)
        | McpInventoryError::ProjectRoot(_)
        | McpInventoryError::Accounts(_)
        | McpInventoryError::AccountId
        | McpInventoryError::Driver { .. }) => HandlerError::Internal(Box::new(fault)),
    }
}
