//! `mcp.server.list` and `mcp.server.read`, answered from the MCP server inventory: a binding the
//! inventory does not hold is refused by its code, a list names each provider whose read failed
//! beside the others' rows, a read answers a driver's failure as the driver's error answers a call,
//! and any other source it could not read is a fault.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::mcp::governance::{McpServerList, McpServerRead};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::requests::{McpServerListRequest, McpServerReadResponse};
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
                inventory
                    .list(&request)
                    .await
                    .map_err(inventory_handler_error)
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

/// The reply to an inventory failure: a refusal by its code, a driver's read as the driver's
/// error answers a call, and every other source that could not be read a fault inside the daemon.
fn inventory_handler_error(error: McpInventoryError) -> HandlerError {
    match error {
        McpInventoryError::Refused(refusal) => HandlerError::Refused(DomainError::from(*refusal)),
        McpInventoryError::Driver { source, .. } => HandlerError::from(source),
        fault @ (McpInventoryError::Projects(_)
        | McpInventoryError::ProjectRoot(_)
        | McpInventoryError::Accounts(_)
        | McpInventoryError::AccountId) => HandlerError::Internal(Box::new(fault)),
    }
}
