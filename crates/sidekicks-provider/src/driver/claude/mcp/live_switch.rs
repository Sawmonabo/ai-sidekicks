//! A Claude Code session's own switch of its tool servers, kept with the session: the stored set
//! its next spawn or resume starts with, and an `on` that clears Claude Code's own switch-off of
//! the server, which its `/mcp` keeps in the project's entry of the process's config.

use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::time::Instant;

use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::{ClaudePersonConfigFiles, switch_on_in_claude_project};
use crate::driver::claude::mcp::precedence::claude_reported_server_name;
use crate::driver::claude::spawn::one_shot_command::CLAUDE_MCP_WRITE_TIMEOUT;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::session_switch::McpSessionSwitch;
use crate::driver::mcp_server::write::{McpServerWriteOutcome, McpServerWriteRefusal};
use crate::driver::session_control::SessionToolServer;

/// Why Claude Code's own switch-off of a server the person switched on could not be cleared.
#[derive(Debug, thiserror::Error)]
enum ClaudeSwitchOffClearError {
    /// The edit of the process's config surely did not land.
    #[error("Claude Code's own switch-off of the server could not be cleared: {0:?}")]
    Refused(McpServerWriteRefusal),
    /// The edit may or may not have landed.
    #[error("whether Claude Code's own switch-off of the server was cleared is not known")]
    Unknown,
}

impl ClaudeDriver {
    /// Switches the session's tool servers to `tool_servers` by writing the set to run `run_id`'s
    /// stored leg, which the session's next spawn or resume reads, and answers `AtNextStart`.
    /// For `switched_on`, a server of the set, it first takes the server out of the list Claude
    /// Code's own `/mcp` switched off in the live process's config, under the project the process
    /// runs in, so that start loads it. Fails as that edit or the stored write fails.
    pub(crate) async fn switch_session_mcp_servers(
        &self,
        session_id: SessionId,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
        switched_on: Option<McpServerName>,
    ) -> Result<McpSessionSwitch, DriverError> {
        let switched_on = switched_on.and_then(|server_name| {
            tool_servers
                .iter()
                .find(|tool_server| tool_server.binding.server_name() == &server_name)
        });
        if let Some(switched_on) = switched_on {
            let reported_name = claude_reported_server_name(&switched_on.binding);
            self.clear_claude_switch_off(session_id, &reported_name)
                .await?;
        }
        self.sources
            .runtime_bindings
            .replace_tool_servers(run_id, tool_servers)
            .await
            .map_err(DriverError::Internal)?;
        Ok(McpSessionSwitch::AtNextStart)
    }

    // Takes `reported_name` out of the switch-off list of the live process's project, in the
    // config its own environment names. A switch-off the person sees is one a live process
    // reports, so with none live there is nothing to clear.
    async fn clear_claude_switch_off(
        &self,
        session_id: SessionId,
        reported_name: &str,
    ) -> Result<(), DriverError> {
        let Some(parts) = self.composed_parts() else {
            return Ok(());
        };
        let Some(live) = parts.slots().live_after_transitions(session_id).await else {
            return Ok(());
        };
        let legs = &live.spawn_bound_legs;
        let config =
            ClaudePersonConfigFiles::resolve(&legs.spawn_environment, &self.sources.home_folder)
                .await;
        // Claude Code keys a project by its repository's main checkout, else by the folder.
        let project = self
            .sources
            .read_repository(&legs.working_directory)
            .await?
            .map_or_else(
                || legs.working_directory.clone(),
                |(repository, _is_owned_by_user)| repository.root,
            );
        let outcome = switch_on_in_claude_project(
            config.person_config,
            project.to_string_lossy().into_owned(),
            reported_name,
            Instant::now() + CLAUDE_MCP_WRITE_TIMEOUT,
        )
        .await;
        match outcome {
            McpServerWriteOutcome::Applied { .. } => Ok(()),
            McpServerWriteOutcome::Refused(refusal) => Err(DriverError::Internal(Box::new(
                ClaudeSwitchOffClearError::Refused(refusal),
            ))),
            McpServerWriteOutcome::Unknown => Err(DriverError::Internal(Box::new(
                ClaudeSwitchOffClearError::Unknown,
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};

    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::channel::ScriptedChannel;
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::mcp_server::session_switch::McpSessionSwitch;
    use crate::driver::session_control::SessionToolServer;
    use crate::driver::test_registry::new_run_id;

    // An `on` for a server Claude Code's own `/mcp` switched off in the live process's project
    // takes it out of that project's list in the process's config, every other member kept.
    // Killed by the clear left out, by the server's name looked up under another project, and by
    // the edit made in a config other than the one the process's environment names.
    #[tokio::test]
    async fn on_clears_claude_codes_own_switch_off_of_the_server() {
        let fixture = ScriptedDriver::new();
        let channel = Arc::new(ScriptedChannel::default());
        let session_id = fixture.create(&channel).await;
        // The fixture's accounts run on Claude Code's default folder in its home.
        let config_file = fixture.home.join(".claude").join(".claude.json");
        let project = fixture.work.to_string_lossy().into_owned();
        let switched_off = json!(["tracker", "docs"]);
        std::fs::create_dir_all(fixture.home.join(".claude")).expect("the test makes the home");
        std::fs::write(
            &config_file,
            json!({
                "numStartups": 3,
                "projects": {
                    project.clone(): {"disabledMcpServers": switched_off, "allowedTools": []},
                },
            })
            .to_string(),
        )
        .expect("the test writes the process's config");
        let tracker = McpServerName::new("tracker".to_owned()).expect("a server name");
        let tracker_on = SessionToolServer {
            binding: McpServerBindingRef::User {
                provider: DESCRIPTOR.provider_id(),
                server_name: tracker.clone(),
            },
            is_enabled: true,
        };

        let switched = fixture
            .driver
            .switch_session_mcp_servers(session_id, new_run_id(), vec![tracker_on], Some(tracker))
            .await
            .expect("the switch is made");

        assert_eq!(switched, McpSessionSwitch::AtNextStart);
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(&config_file).expect("the config is still there"),
        )
        .expect("the config is JSON");
        assert_eq!(
            config,
            json!({
                "numStartups": 3,
                "projects": {
                    project: {"disabledMcpServers": ["docs"], "allowedTools": []},
                },
            })
        );
    }
}
