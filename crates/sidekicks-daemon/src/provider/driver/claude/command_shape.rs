//! The string shape Claude Code hands its shell prefix for a Bash tool call, which tells an agent's
//! command from the hooks, status line and tool-server starts it runs through the same prefix.

use std::sync::LazyLock;

use regex::Regex;

use crate::provider::driver::ShellPrefixCommand;

/// The variable Claude Code reads its shell prefix's absolute path from.
const SHELL_PREFIX_VARIABLE: &str = "CLAUDE_CODE_SHELL_PREFIX";

/// A Bash tool call's line: `eval '<command>' < /dev/null && pwd -P >| <file>`, the command
/// single-quoted with each of its own quotes written `'\''`.
static BASH_COMMAND_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^eval '((?:[^']|'\\'')*)' < /dev/null && pwd -P >\| [^\s]+$")
        .expect("the pattern is valid")
});

/// Claude Code's contract with the command wrapper's link.
pub(super) const CLAUDE_SHELL_PREFIX_COMMAND: ShellPrefixCommand = ShellPrefixCommand {
    variable: SHELL_PREFIX_VARIABLE,
    read_agent_command: read_bash_command,
};

/// The command a Bash tool call's `line` runs, its quotes unescaped; `None` for any other line.
fn read_bash_command(line: &str) -> Option<String> {
    let quoted = BASH_COMMAND_LINE.captures(line)?.get(1)?.as_str();
    Some(quoted.replace(r"'\''", "'"))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::read_bash_command;

    // Fails when a hook, a status line or a tool server's start is taken for an agent's command,
    // whose capture would then hold it, or when a Bash line or its quoting is missed.
    #[rstest]
    #[case::bash(
        "eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd",
        Some("npm test")
    )]
    #[case::bash_with_a_quote(
        r"eval 'echo '\''hi'\''' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd",
        Some("echo 'hi'")
    )]
    #[case::hook("/Users/me/.claude/hooks/format.sh", None)]
    #[case::tool_server_start("npx -y @modelcontextprotocol/server-filesystem /tmp", None)]
    #[case::no_closed_input("eval 'npm test' && pwd -P >| /tmp/claude-1a2b-cwd", None)]
    #[case::plain_redirect("eval 'npm test' < /dev/null && pwd -P > /tmp/claude-1a2b-cwd", None)]
    #[case::eval_inside("echo eval 'npm test' < /dev/null && pwd -P >| /tmp/cwd", None)]
    fn a_bash_line_is_told_from_every_other_line(
        #[case] line: &str,
        #[case] command: Option<&str>,
    ) {
        assert_eq!(read_bash_command(line).as_deref(), command);
    }
}
