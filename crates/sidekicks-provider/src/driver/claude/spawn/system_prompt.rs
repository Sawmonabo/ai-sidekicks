//! The text every Claude Code process appends to its system prompt (`--append-system-prompt`):
//! what the agent must know about how the daemon runs it, one section per topic.

/// The appended text: a background Bash command is stopped at its `timeout`, or after 30 minutes
/// without one, which nothing a host sends turns off, so the agent sets a timeout and starts what
/// must keep running through `shell_run`.
const CLAUDE_APPENDED_SYSTEM_PROMPT: &str = concat!(
    "# Long-running commands\n\n",
    "When you start a long-running command with Bash and run_in_background, set `timeout` to how ",
    "long you expect it to run, plus a margin, in milliseconds. Without one, it is stopped after ",
    "30 minutes. A server, a watcher, or anything meant to keep running until someone stops it ",
    "does not go through Bash: start it with the shell_run tool, which runs it in a session ",
    "terminal that keeps going.",
);

/// The two arguments that append the daemon's text to a process's system prompt, which every
/// process's command line carries.
pub(crate) fn claude_appended_system_prompt_arguments() -> [&'static str; 2] {
    ["--append-system-prompt", CLAUDE_APPENDED_SYSTEM_PROMPT]
}
