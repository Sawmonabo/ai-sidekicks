//! A Claude Code session's own switch of its tool servers, kept with the session: the stored set
//! its next spawn or resume starts with. The switch never writes Claude Code's own config, which
//! every session of the account and project reads.

use sidekicks_contracts::run::id::RunId;

use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::session_switch::McpSessionSwitch;
use crate::driver::session_control::SessionToolServer;

impl ClaudeDriver {
    /// Switches the session's tool servers to `tool_servers` by writing the set to run `run_id`'s
    /// stored leg, which the session's next spawn or resume reads, and answers `AtNextStart`.
    /// Fails as the stored write fails.
    pub(crate) async fn switch_session_mcp_servers(
        &self,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
    ) -> Result<McpSessionSwitch, DriverError> {
        self.sources
            .runtime_bindings
            .replace_tool_servers(run_id, tool_servers)
            .await
            .map_err(DriverError::Internal)?;
        Ok(McpSessionSwitch::AtNextStart)
    }
}
