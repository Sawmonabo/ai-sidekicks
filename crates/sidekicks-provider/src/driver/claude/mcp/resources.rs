//! How the daemon reaches one of a Claude Code session's servers to list what it offers, since
//! Claude Code lists a server's resources to no one but its model: the binding the session serves
//! the name from, its entry read from the person's own config for this call alone and filled as
//! Claude Code fills it on load, and the session process's environment and folder a program server
//! starts in. A server whose entry signs in itself or fetches its headers from a program is the
//! provider's to reach, never the daemon's.

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::PathRules;

use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::ClaudeServerEntryReader;
use crate::driver::claude::mcp::machine_probe::sent_entry::{
    SentEntry, compose_sent_entry, is_signed_in_by_provider,
};
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::resources::{
    McpResourceSource, McpServerReach, not_a_session_server,
};
use crate::spawn_environment::remove_environment_names;

impl ClaudeDriver {
    /// How the daemon reaches `server_name`, a server `session_id`'s live process runs, to list
    /// its resources: by its entry as the person's config holds it now, its variables and a
    /// plugin's placeholders filled from the process's environment as Claude Code fills them, a
    /// program in the process's own environment and folder with the entry's values over them, or
    /// an address with its headers; `SignedInByProvider` for an entry whose credentials Claude
    /// Code makes itself. Refused `mcp.server.notRunning` for a name the session does not run,
    /// and `provider.unavailable` for an entry the daemon has no way to reach.
    pub(crate) async fn list_mcp_resources(
        &self,
        session_id: SessionId,
        server_name: McpServerName,
    ) -> Result<McpResourceSource, DriverError> {
        let live = self.parts()?.run_start.live_session(session_id)?;
        let binding = live
            .spawn_bound_legs
            .tool_servers
            .iter()
            .find(|tool_server| tool_server.binding.server_name() == &server_name)
            .map(|tool_server| tool_server.binding.clone())
            .ok_or_else(|| DriverError::from(not_a_session_server(&server_name)))?;
        let (person, plugin_home) = self.resolve_mcp_entry_places().await;
        let declared = ClaudeServerEntryReader::new(&person, &plugin_home)
            .read(&binding)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))?
            .filter(|declared| declared.entry.is_object())
            .ok_or_else(|| DriverError::from(not_a_session_server(&server_name)))?;
        if is_signed_in_by_provider(&declared.entry) {
            return Ok(McpResourceSource::SignedInByProvider);
        }
        let unreachable = |words: &str| {
            DriverError::from(DomainError::new(
                format!("{} {words}", server_name.as_str()),
                RefusalCode::ProviderUnavailable,
            ))
        };
        let mut environment = live.spawn_bound_legs.spawn_environment.clone();
        let working_folder = &live.spawn_bound_legs.working_directory;
        let project = working_folder.to_string_lossy().into_owned();
        let reach = match compose_sent_entry(declared, &environment, Some(project)) {
            SentEntry::Sent(ClaudeToolServerEntry::Stdio { command, args, env }) => {
                let names: Vec<&str> = env.keys().map(String::as_str).collect();
                remove_environment_names(&mut environment, &names, PathRules::NATIVE);
                environment.extend(env);
                McpServerReach::Stdio {
                    program: command,
                    arguments: args,
                    environment,
                    working_folder: Some(working_folder.clone()),
                }
            }
            SentEntry::Sent(ClaudeToolServerEntry::Http { url, headers }) => {
                McpServerReach::Address {
                    address: McpServerAddress::new(&url).ok_or_else(|| {
                        unreachable("is declared at an address that does not read")
                    })?,
                    headers: headers.into_iter().collect(),
                }
            }
            SentEntry::Sent(ClaudeToolServerEntry::Sse { .. }) => {
                return Err(unreachable(
                    "is reached over server-sent events, which the daemon cannot read",
                ));
            }
            SentEntry::Sent(ClaudeToolServerEntry::Sdk { .. }) | SentEntry::Unsendable => {
                return Err(unreachable("is declared in a form the daemon cannot reach"));
            }
        };
        Ok(McpResourceSource::Reach { binding, reach })
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};

    use crate::driver::claude::session::scripted::ScriptedSession;
    use crate::driver::claude::session::scripted::driver::create_params;
    use crate::driver::mcp_server::resources::{McpResourceSource, McpServerReach};
    use crate::driver::session_control::{CreateSessionParams, SessionToolServer};

    // A session's server whose entry signs in through Claude Code itself, or fetches its headers
    // from a program, is Claude Code's to reach; a program is reached with its entry's variables
    // filled. Killed by the sign-in check dropped, which refuses such an entry as one the daemon
    // cannot reach, and by the entry's variables left as written.
    #[rstest]
    #[case::its_own_sign_in(
        json!({"type": "http", "url": "https://example.com/mcp", "oauth": {"clientId": "c"}}),
        None
    )]
    #[case::headers_from_a_program(
        json!({"type": "http", "url": "https://example.com/mcp", "headersHelper": "/bin/headers"}),
        None
    )]
    #[case::a_program(
        json!({"command": "docs-server", "args": ["${DOCS_FOLDER:-/docs}"]}),
        Some("/docs")
    )]
    #[tokio::test]
    async fn a_server_signed_in_by_claude_code_is_its_own_to_reach(
        #[case] entry: Value,
        #[case] filled_argument: Option<&str>,
    ) {
        let binding: McpServerBindingRef = serde_json::from_value(json!({
            "scope": "user", "provider": "claude", "serverName": "docs"
        }))
        .unwrap();
        let tool_server = SessionToolServer {
            binding,
            is_enabled: true,
        };
        let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
            tool_servers: Some(vec![tool_server]),
            ..create_params(session_id)
        })
        .await;
        tokio::fs::create_dir_all(&session.home).await.unwrap();
        tokio::fs::write(
            session.home.join(".claude.json"),
            json!({"mcpServers": {"docs": entry}}).to_string(),
        )
        .await
        .unwrap();

        let source = session
            .driver
            .list_mcp_resources(
                session.session_id,
                McpServerName::new("docs".to_owned()).unwrap(),
            )
            .await
            .unwrap();

        match (source, filled_argument) {
            (McpResourceSource::SignedInByProvider, None) => {}
            (
                McpResourceSource::Reach {
                    reach: McpServerReach::Stdio { arguments, .. },
                    ..
                },
                Some(filled_argument),
            ) => assert_eq!(arguments, [filled_argument]),
            (source, _) => panic!("the server reads as another source: {source:?}"),
        }
    }
}
