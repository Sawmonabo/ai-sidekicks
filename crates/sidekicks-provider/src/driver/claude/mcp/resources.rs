//! How the daemon reaches one of a Claude Code session's servers to list what it offers, since
//! Claude Code lists a server's resources to no one but its model: the binding the session serves
//! the name from, its entry read from the person's own config for this call alone, and the
//! session process's environment and folder a program server starts in. A server whose entry signs
//! in itself or fetches its headers from a program is the provider's to reach, never the daemon's.

use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::PathRules;

use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::machine_probe::sent_entry::compose_tool_server_entry;
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::resources::{McpResourceSource, McpServerReach};
use crate::driver::mcp_server::write::McpServerObservedEntry;
use crate::spawn_environment::remove_environment_names;

/// The members of an entry whose credentials Claude Code makes itself: its own sign-in, and a
/// program it runs for each request's headers.
const PROVIDER_CREDENTIAL_MEMBERS: [&str; 2] = ["oauth", "headersHelper"];

impl ClaudeDriver {
    /// How the daemon reaches `server_name`, a server `session_id`'s live process runs, to list
    /// its resources: by its entry as the person's config holds it now, a program in the
    /// process's own environment and folder with the entry's values over them, or an address
    /// with its headers; `SignedInByProvider` for an entry whose credentials Claude Code makes
    /// itself. Refused `mcp.server.notRunning` for a name the session does not run, and
    /// `provider.unavailable` for an entry the daemon has no way to reach.
    pub(crate) async fn list_mcp_resources(
        &self,
        session_id: SessionId,
        server_name: McpServerName,
    ) -> Result<McpResourceSource, DriverError> {
        let live = self.parts()?.run_start.live_session(session_id)?;
        let not_running = || {
            DriverError::from(DomainError::new(
                format!(
                    "{} is not one of this session's tool servers",
                    server_name.as_str()
                ),
                RefusalCode::McpServerNotRunning,
            ))
        };
        let binding = live
            .spawn_bound_legs
            .tool_servers
            .iter()
            .find(|tool_server| tool_server.binding.server_name() == &server_name)
            .map(|tool_server| tool_server.binding.clone())
            .ok_or_else(not_running)?;
        let McpServerObservedEntry::Present(entry) = self.observe_mcp_server(&binding).await?.entry
        else {
            return Err(not_running());
        };
        if PROVIDER_CREDENTIAL_MEMBERS
            .iter()
            .any(|member| entry.members().contains_key(*member))
        {
            return Ok(McpResourceSource::SignedInByProvider);
        }
        let unreachable = |words: &str| {
            DriverError::from(DomainError::new(
                format!("{} {words}", server_name.as_str()),
                RefusalCode::ProviderUnavailable,
            ))
        };
        let reach = match compose_tool_server_entry(Value::Object(entry.members().clone())) {
            Some(ClaudeToolServerEntry::Stdio { command, args, env }) => {
                let mut environment = live.signed_in_spawn_environment();
                let names: Vec<&str> = env.keys().map(String::as_str).collect();
                remove_environment_names(&mut environment, &names, PathRules::NATIVE);
                environment.extend(env);
                McpServerReach::Stdio {
                    program: command,
                    arguments: args,
                    environment,
                    working_folder: Some(live.spawn_bound_legs.working_directory.clone()),
                }
            }
            Some(ClaudeToolServerEntry::Http { url, headers }) => McpServerReach::Address {
                address: McpServerAddress::new(&url)
                    .ok_or_else(|| unreachable("is declared at an address that does not read"))?,
                headers: headers.into_iter().collect(),
                sign_in: None,
            },
            Some(ClaudeToolServerEntry::Sse { .. }) => {
                return Err(unreachable(
                    "is reached over server-sent events, which the daemon cannot read",
                ));
            }
            Some(ClaudeToolServerEntry::Sdk { .. }) | None => {
                return Err(unreachable("is declared in a form the daemon cannot reach"));
            }
        };
        Ok(McpResourceSource::Reach { binding, reach })
    }
}
