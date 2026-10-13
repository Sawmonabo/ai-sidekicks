//! MCP: the tool servers a provider binds, what the daemon reports about them and what a change to
//! one did to the live sessions behind it, and the `mcp.*` method table.

use crate::typescript::TypeScriptModule;

pub mod governance;
pub mod server;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] =
    &[&governance::TYPESCRIPT_MODULE, &server::TYPESCRIPT_MODULE];
