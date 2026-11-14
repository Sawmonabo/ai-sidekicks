//! The commands and agents of a session at rest, read from a process that keeps nothing, started in
//! the session's folder on its account and offered the session's helpers: its `initialize` reply
//! lists the commands, skills and agents, with no model turn run. The session's own tool servers
//! are not loaded, so their prompts are not in it. The person's hooks are off, and their own MCP
//! files are loaded only where an administrator's MCP file is present, since the flag that skips
//! them makes Claude Code exit at start there.

use std::path::PathBuf;

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcess, compose_claude_control_only_arguments,
};
use crate::driver::claude::spawn::launch::initialize_reply::{
    ClaudeListedCommand, read_claude_initialize_declaration, read_claude_listed_command_rows,
};
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::driver::contract::known_names::ProviderAgent;
use crate::driver::session_control::SubagentDefinition;
use crate::spawned_version::ResolvedProviderExecutable;

/// What one resting session's `initialize` reply lists: its commands and the agents it offers, each
/// in the reply's order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeSessionListing {
    /// The commands and skills.
    pub(crate) commands: Vec<ClaudeListedCommand>,
    /// The agents, the session's helpers among them.
    pub(crate) agents: Vec<ProviderAgent>,
}

// The read's command line: a process that keeps nothing, loading no MCP file of the person's unless
// an administrator's MCP file is present, under which the flag makes Claude Code exit at start.
fn compose_claude_command_read_arguments(has_managed_mcp_file: bool) -> Vec<String> {
    let mut arguments = compose_claude_control_only_arguments(None);
    if !has_managed_mcp_file {
        arguments.push(CLAUDE_NO_MCP_SERVERS.to_owned());
    }
    arguments
}

/// Reads the commands and agents a session in `working_directory` on `provider_account_id`'s
/// account lists, from a process that keeps nothing sent `initialize` alone, offering
/// `definitions` as its agents, and then closed. Every hook of the person's is off, so a
/// `SessionStart` hook never runs on a palette read. Fails as the start or `initialize` does.
pub(crate) async fn read_claude_session_listing(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    working_directory: PathBuf,
    provider_account_id: ProviderAccountId,
    has_managed_mcp_file: bool,
    definitions: &[SubagentDefinition],
) -> Result<ClaudeSessionListing, ClaudeLaunchError> {
    let short = ClaudeShortProcess::start(
        launcher,
        executable,
        compose_claude_command_read_arguments(has_managed_mcp_file),
        working_directory,
        Some(provider_account_id),
        None,
        true,
    )
    .await?;
    // Sent first and alone, so its wait for the command load is cut short by no other request.
    let reply = short.initialize_offering(definitions).await;
    short.close().await;
    let reply = reply?;
    Ok(ClaudeSessionListing {
        commands: read_claude_listed_command_rows(reply.as_deref()),
        agents: read_claude_initialize_declaration(reply.as_deref()).agents,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::Value;
    use sidekicks_platforms::ProgramStart;
    use sidekicks_std::file::atomic_write::write_file_atomically;

    use super::{
        ClaudeSessionListing, compose_claude_command_read_arguments, read_claude_session_listing,
    };
    use crate::driver::CurrentProviderAccount;
    use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
    use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
    use crate::driver::contract::known_names::ProviderAgent;
    use crate::driver::session_control::SubagentDefinition;
    use crate::driver::test_registry::{registered_test_accounts, test_driver_services};
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawned_version::ResolvedProviderExecutable;

    // A stand-in that keeps the first request it reads, the `initialize`, in `$RECORD`, and answers
    // it with one agent and no command.
    const STAND_IN: &str = r#"#!/bin/sh
read -r line
printf '%s' "$line" > "$RECORD"
id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s",'\
'"response":{"commands":[],"agents":[{"name":"planner","description":"Plans the work"}]}}}\n' \
  "$id"
while read -r line; do :; done
"#;

    // Killed by a read that loads the person's MCP files, and by one passing the strict flag under
    // an administrator's MCP file, which makes Claude Code exit at start.
    #[rstest]
    #[case::no_managed_file(false)]
    #[case::managed_file(true)]
    fn the_read_loads_no_mcp_file_of_the_persons(#[case] has_managed_mcp_file: bool) {
        let arguments = compose_claude_command_read_arguments(has_managed_mcp_file);

        assert_eq!(
            arguments
                .iter()
                .any(|argument| argument == CLAUDE_NO_MCP_SERVERS),
            !has_managed_mcp_file
        );
    }

    // The resting read offers the session's helpers in the `initialize` its process is sent, and
    // answers the agents the reply lists. Killed by the read sending a plain `initialize`, which
    // offers no helpers.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_resting_read_offers_the_sessions_helpers_in_its_initialize() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let program = folder.path().join("claude-stand-in");
        write_file_atomically(&program, STAND_IN, 0o755)
            .await
            .expect("the stand-in is written");
        let record = folder.path().join("initialize");
        let services = test_driver_services();
        let launcher = ClaudeProcessLauncher::new(
            services.spawner.clone(),
            Arc::clone(&services.child_records),
            Arc::clone(&services.processes),
            registered_test_accounts(CurrentProviderAccount::NoneRegistered),
            Arc::clone(&services.ports.telemetry_target),
            Arc::clone(&services.ports.raw_provider_messages),
            folder.path(),
        );
        let executable = ResolvedProviderExecutable {
            requested_command: "claude".to_owned(),
            resolved_executable_path: program.clone(),
            start: ProgramStart {
                program,
                leading_arguments: Vec::new(),
            },
            environment: vec![
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("RECORD".to_owned(), record.to_string_lossy().into_owned()),
            ],
        };
        let planner = SubagentDefinition {
            name: "planner".to_owned(),
            prompt: "Plan it.".to_owned(),
            description: "Plans the work".to_owned(),
            model: None,
            tools: None,
            effort: None,
            max_turns: None,
        };

        let listing = read_claude_session_listing(
            &launcher,
            &executable,
            folder.path().to_path_buf(),
            test_provider_account_id(),
            false,
            &[planner],
        )
        .await
        .expect("the listing reads");

        let sent: Value = serde_json::from_str(
            &std::fs::read_to_string(&record).expect("the stand-in kept the request"),
        )
        .expect("the request is JSON");
        assert_eq!(sent["request"]["subtype"], "initialize");
        assert_eq!(
            sent["request"]["agents"]
                .as_object()
                .map(|agents| agents.keys().cloned().collect::<Vec<_>>()),
            Some(vec!["planner".to_owned()]),
            "the helpers are offered by name"
        );
        assert_eq!(
            listing,
            ClaudeSessionListing {
                commands: Vec::new(),
                agents: vec![ProviderAgent {
                    name: "planner".to_owned(),
                    description: Some("Plans the work".to_owned()),
                }],
            }
        );
    }
}
