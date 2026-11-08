//! The command list of a session at rest, read from a process that keeps nothing, started in the
//! session's folder on its account: its `initialize` reply lists the commands and skills, with no
//! model turn run. The session's own tool servers are not loaded, so their prompts are not in it.
//! The person's hooks are off, and their own MCP files are loaded only where an administrator's
//! MCP file is present, since the flag that skips them makes Claude Code exit at start there.

use std::path::PathBuf;

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcess, compose_claude_control_only_arguments,
};
use crate::driver::claude::spawn::launch::initialize_reply::{
    ClaudeListedCommand, read_claude_listed_command_rows,
};
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::spawned_version::ResolvedProviderExecutable;

// The read's command line: a process that keeps nothing, loading no MCP file of the person's unless
// an administrator's MCP file is present, under which the flag makes Claude Code exit at start.
fn compose_claude_command_read_arguments(has_managed_mcp_file: bool) -> Vec<String> {
    let mut arguments = compose_claude_control_only_arguments(None);
    if !has_managed_mcp_file {
        arguments.push(CLAUDE_NO_MCP_SERVERS.to_owned());
    }
    arguments
}

/// Reads the commands a session in `working_directory` on `provider_account_id`'s account lists,
/// from a process that keeps nothing sent `initialize` alone and then closed, in the reply's
/// order. Every hook of the person's is off, so a `SessionStart` hook never runs on a palette
/// read. Fails as the start or `initialize` does.
pub(crate) async fn read_claude_session_commands(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    working_directory: PathBuf,
    provider_account_id: ProviderAccountId,
    has_managed_mcp_file: bool,
) -> Result<Vec<ClaudeListedCommand>, ClaudeLaunchError> {
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
    let reply = short.initialize().await;
    short.close().await;
    Ok(read_claude_listed_command_rows(reply?.as_deref()))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::compose_claude_command_read_arguments;
    use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
    use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;

    // Killed by a read that loads the person's hooks or MCP files, by hooks turned off on every
    // short process, and by one passing the strict flag under an administrator's MCP file, which
    // makes Claude Code exit at start.
    #[rstest]
    #[case::no_managed_file(false)]
    #[case::managed_file(true)]
    fn the_read_turns_hooks_off_and_loads_no_mcp_file_of_the_persons(
        #[case] has_managed_mcp_file: bool,
    ) {
        let arguments = compose_claude_command_read_arguments(has_managed_mcp_file);
        let hooks_off = |are_hooks_off| {
            serde_json::to_value(ClaudeSpawnSettings::short_process(are_hooks_off))
                .expect("the settings serialize")["disableAllHooks"]
                .clone()
        };

        assert_eq!(hooks_off(true), json!(true));
        assert_eq!(hooks_off(false), Value::Null);
        assert_eq!(
            arguments
                .iter()
                .any(|argument| argument == CLAUDE_NO_MCP_SERVERS),
            !has_managed_mcp_file
        );
    }
}
