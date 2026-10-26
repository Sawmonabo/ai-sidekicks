//! The string shape Claude Code hands its shell prefix for a Bash tool call, which tells an agent's
//! command from the hooks, status line and tool-server starts it runs through the same prefix.

use std::sync::LazyLock;

use regex::Regex;

use crate::provider::driver::ShellPrefixCommand;

/// The variable Claude Code reads its shell prefix's absolute path from.
const SHELL_PREFIX_VARIABLE: &str = "CLAUDE_CODE_SHELL_PREFIX";

/// The variable Claude Code sets, in a Bash command's environment, to the bash or zsh it wrote the
/// command's line for.
const LINE_SHELL_VARIABLE: &str = "SHELL";

/// A Bash tool call's line: any setup parts joined by ` && `, then `eval <command>`, the command
/// single-quoted with each of its own quotes written `'"'"'` or left bare when it is one plain
/// word, its input closed with `< /dev/null` unless it redirects its own, then
/// `pwd -P >| <file>`. The first `eval` at a part's start is the command's: a quoted command holds
/// no bare quote, so no later one can close its quotes.
static BASH_COMMAND_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?:^| && )eval (?:'((?:[^']|'"'"')*)'|([A-Za-z0-9_./:=@+,-]+))"#,
        r#"(?: < /dev/null)? && pwd -P >\| [^\n]+$"#,
    ))
    .expect("the pattern is valid")
});

/// What Claude Code's line rewrites in a command before it runs it: a redirect to `nul` becomes
/// one to `/dev/null`, unless the command holds a `<`, a `$` or a backquote.
static NUL_REDIRECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d?&?>+[ \t]*)[Nn][Uu][Ll]([\s|&;)]|$)").expect("the pattern is valid")
});

/// Claude Code's contract with the command wrapper's link.
pub(super) const CLAUDE_SHELL_PREFIX_COMMAND: ShellPrefixCommand = ShellPrefixCommand {
    variable: SHELL_PREFIX_VARIABLE,
    shell_variable: LINE_SHELL_VARIABLE,
    read_agent_command: read_bash_command,
};

/// The command a Bash tool call's `line` runs, its quotes unescaped; `None` for any other line.
fn read_bash_command(line: &str) -> Option<String> {
    let captures = BASH_COMMAND_LINE.captures(line)?;
    if let Some(quoted) = captures.get(1) {
        return Some(quoted.as_str().replace(r#"'"'"'"#, "'"));
    }
    Some(captures.get(2)?.as_str().to_owned())
}

/// The text Claude Code's line runs for the Bash tool call `command`, which a wrapper names when it
/// starts and its row is paired by.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver pairs each Bash command's row by the text its line runs"
    )
)]
pub(super) fn bash_line_text(command: &str) -> String {
    if command.contains(['<', '$', '`']) {
        return command.to_owned();
    }
    NUL_REDIRECT
        .replace_all(command, "${1}/dev/null${2}")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{bash_line_text, read_bash_command};

    /// The setup parts Claude Code 2.1.310 puts before `eval` when a shell prefix is set.
    const SETUP: &str = "source '/Users/me/.claude/shell-snapshots/snapshot-zsh-1-ab.sh' \
                         2>/dev/null || true && { shopt -u extglob || setopt NO_EXTENDED_GLOB \
                         NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true && { \\builtin unalias -- \
                         'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true";

    // Fails when a hook, a status line or a tool server's start is taken for an agent's command,
    // whose capture would then hold it, or when a Bash line in any shape Claude Code writes, or
    // its quoting, is missed. Mutations: drop the setup prefix `(?:^| && )`; make `< /dev/null`
    // required; unquote `'\''` in place of `'"'"'`.
    #[rstest]
    #[case::setup_prefix(
        &format!("{SETUP} && eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"),
        Some("npm test")
    )]
    #[case::bare_line(
        "eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd",
        Some("npm test")
    )]
    #[case::quoted_quote(
        &format!(r#"{SETUP} && eval 'echo '"'"'hi'"'"'' < /dev/null && pwd -P >| /tmp/c-cwd"#),
        Some("echo 'hi'")
    )]
    #[case::own_input_redirect(
        &format!("{SETUP} && eval 'sort < names.txt' && pwd -P >| /tmp/claude-1a2b-cwd"),
        Some("sort < names.txt")
    )]
    #[case::pipe(
        &format!("{SETUP} && eval 'yes | head -1' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"),
        Some("yes | head -1")
    )]
    #[case::one_plain_word("eval ls < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd", Some("ls"))]
    #[case::eval_inside_the_command(
        r#"eval 'a && eval '"'"'b'"'"'' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"#,
        Some("a && eval 'b'")
    )]
    #[case::heredoc(
        "eval 'cat <<'\"'\"'EOF'\"'\"'\nhi\nEOF' && pwd -P >| /tmp/claude-1a2b-cwd",
        Some("cat <<'EOF'\nhi\nEOF")
    )]
    #[case::empty_command("eval '' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd", Some(""))]
    #[case::hook("/Users/me/.claude/hooks/format.sh", None)]
    #[case::hook_ending_in_pwd("cd /tmp && make && pwd", None)]
    #[case::tool_server_start("npx -y @modelcontextprotocol/server-filesystem /tmp", None)]
    #[case::plain_redirect("eval 'npm test' < /dev/null && pwd -P > /tmp/claude-1a2b-cwd", None)]
    #[case::eval_not_a_part("echo eval 'npm test' < /dev/null && pwd -P >| /tmp/cwd", None)]
    fn a_bash_line_is_told_from_every_other_line(
        #[case] line: &str,
        #[case] command: Option<&str>,
    ) {
        assert_eq!(read_bash_command(line).as_deref(), command);
    }

    // Fails when a row is paired by the tool call's own text where the line runs another, or by a
    // rewrite Claude Code does not make. Mutation: drop the `<`, `$` and backquote guard.
    #[rstest]
    #[case::nul("make 2>nul", "make 2>/dev/null")]
    #[case::nul_before_a_pipe("make >NUL | tee", "make >/dev/null | tee")]
    #[case::dollar_kept("echo $HOME >nul", "echo $HOME >nul")]
    #[case::a_word("cat null.txt", "cat null.txt")]
    fn a_command_is_paired_by_the_text_its_line_runs(#[case] command: &str, #[case] text: &str) {
        assert_eq!(bash_line_text(command), text);
    }
}
