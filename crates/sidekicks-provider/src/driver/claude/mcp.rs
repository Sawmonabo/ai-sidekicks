//! Claude Code's MCP servers as the driver reads them: the person's own config, each account's
//! connectors and organization servers, and Claude Code's precedence over them.

mod config;
pub(crate) mod connectors;
pub(crate) mod organization;
pub(crate) mod precedence;
