//! How macOS's own `/bin/bash`, a 3.2 Apple patched, starts as a terminal's login shell. It never
//! reads `ENV` in a posix-mode start, so it starts as a login shell that skips its login files,
//! `-bash --noprofile`, and its first prompt command runs what bash skipped as Apple's bash runs
//! it: the managed system profile where one exists, otherwise `/etc/profile`, then the person's
//! first login file, after which the marks script loads. It starts with an empty `HISTFILE`, since
//! a bash that skipped its login files reads its history at the default 500 lines and writes back
//! no more than that; the marks script reads the history once the login files have sized it.

use sidekicks_contracts::machine::settings::{
    SHELL_BASH_SCRIPT_ENVIRONMENT_NAME, SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME,
    SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME,
};

use crate::bash_start::{BashStart, BashStartInput};
use crate::path::rules::PathRules;

/// macOS's own bash, which skips a posix-mode start's `ENV`.
pub(crate) const MACOS_OWN_BASH_PATH: &str = "/bin/bash";

// The program name a login names a shell by, which makes bash a login shell.
const APPLE_BASH_LOGIN_NAME: &str = "-bash";

// The system profile Apple's bash reads at a login, and the managed one read in its place wherever
// it exists, as an administrator's profile.
const SYSTEM_PROFILE_PATH: &str = "/etc/profile";
const MANAGED_SYSTEM_PROFILE_PATH: &str =
    "/private/var/db/ManagedConfigurationFiles/com.apple.bash/etc/profile";

/// Starts macOS's own bash as a login shell that reads no login file and no history, through a
/// bash that only names it `-bash`, and whose posix mode keeps it from reading `BASH_ENV`. The
/// first prompt command runs the login files and loads the marks script.
pub(crate) fn start_macos_own_bash(input: &BashStartInput<'_>) -> BashStart {
    let carried = |name: &str, carrier: &str| {
        PathRules::NATIVE
            .environment_value(input.environment, name)
            .map(|value| (carrier.to_owned(), value.to_owned()))
    };
    let pairs = carried(
        "PROMPT_COMMAND",
        SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME,
    )
    .into_iter()
    .chain(carried(
        "HISTFILE",
        SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME,
    ))
    .chain([
        (
            SHELL_BASH_SCRIPT_ENVIRONMENT_NAME.to_owned(),
            input.script_path.to_owned(),
        ),
        ("PROMPT_COMMAND".to_owned(), first_prompt_command()),
        ("HISTFILE".to_owned(), String::new()),
    ])
    .collect();
    BashStart {
        program: MACOS_OWN_BASH_PATH.to_owned(),
        arguments: vec![
            "--posix".to_owned(),
            "-c".to_owned(),
            format!("exec -a {APPLE_BASH_LOGIN_NAME} {MACOS_OWN_BASH_PATH} --noprofile"),
        ],
        pairs,
    }
}

// The first prompt command, run once at the top level: it puts back the person's own prompt
// command, unexported so it never reaches a child, and their own `HISTFILE`, exported as it came,
// or else unexports the empty one and marks it for the default once the login files have run;
// names the system profile Apple's bash would have read; and evaluates the marks script, which
// runs the login files, reads the history, adds its hooks and runs the first prompt's commands.
// Evaluating rather than sourcing it keeps the DEBUG trap it sets, which bash 3.2 puts back once
// a sourced file ends.
fn first_prompt_command() -> String {
    let quote = |word: &str| {
        PathRules::Posix
            .quote_shell_word(word)
            .expect("a POSIX shell takes every word")
    };
    let managed = quote(MANAGED_SYSTEM_PROFILE_PATH);
    let profile = quote(SYSTEM_PROFILE_PATH);
    let original_prompt_command = SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME;
    let original_history_file = SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME;
    let script = SHELL_BASH_SCRIPT_ENVIRONMENT_NAME;
    [
        "builtin export -n PROMPT_COMMAND".to_owned(),
        format!("PROMPT_COMMAND=${{{original_prompt_command}-}}"),
        format!("builtin unset {original_prompt_command}"),
        format!(
            "if [ -n \"${{{original_history_file}+set}}\" ]; then \
             builtin export HISTFILE=\"${original_history_file}\"; \
             builtin unset {original_history_file}; \
             else builtin export -n HISTFILE; __sidekicks_default_history_file=1; fi"
        ),
        format!(
            "if [ -e {managed} ]; then __sidekicks_system_profile={managed}; else \
             __sidekicks_system_profile={profile}; fi"
        ),
        format!("builtin eval \"$(<\"${script}\")\""),
    ]
    .join("\n")
}
