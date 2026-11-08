//! `mcp.registry.search`, answered from the public MCP Registry: no reply in time is refused
//! `provider.timeout`, and any other failure to read a page `provider.unavailable`; the binding
//! edits `mcp.server.upsert` and `mcp.server.enabled.update`, answered by the mutation service;
//! and `mcp.server.signIn` and `mcp.server.signOut`, answered by the sign-in commands.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::mcp::governance::{
    McpRegistrySearch, McpServerEnabledUpdate, McpServerSignIn, McpServerSignOut, McpServerUpsert,
};
use sidekicks_contracts::mcp::server::requests::{
    McpRegistrySearchRequest, McpServerEnabledUpdateRequest, McpServerSignInRequest,
    McpServerSignOutRequest, McpServerUpsertRequest,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_mcp::mutation::service::McpMutationService;
use sidekicks_mcp::registry_search::McpRegistryClient;
use sidekicks_mcp::sign_in::commands::McpSignInCommands;

/// Registers `mcp.registry.search` over `client`, `mcp.server.upsert` and
/// `mcp.server.enabled.update` over `mutations`, and `mcp.server.signIn` and `mcp.server.signOut`
/// over `sign_ins`. Fails the start when one is already registered.
pub(super) fn register_request_methods(
    registry: &mut MethodRegistryBuilder,
    client: Arc<McpRegistryClient>,
    mutations: &Arc<McpMutationService>,
    sign_ins: &Arc<McpSignInCommands>,
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
    )?;
    let sign_in_commands = Arc::clone(sign_ins);
    registry.register::<McpServerSignIn, _>(
        move |request: McpServerSignInRequest, _context: HandlerContext| {
            let sign_ins = Arc::clone(&sign_in_commands);
            async move { sign_ins.sign_in(request).await }.boxed()
        },
    )?;
    let sign_out_commands = Arc::clone(sign_ins);
    registry.register::<McpServerSignOut, _>(
        move |request: McpServerSignOutRequest, _context: HandlerContext| {
            let sign_ins = Arc::clone(&sign_out_commands);
            async move { sign_ins.sign_out(request).await }.boxed()
        },
    )
}
