//! Claude Code's MCP servers as the driver reads them: the person's own config, each account's
//! connectors and organization servers, Claude Code's precedence over them, and the sign-in to
//! one server through Claude Code's own client.

mod config;
pub(crate) mod connectors;
pub(crate) mod organization;
pub(crate) mod precedence;
pub(crate) mod sign_in;
