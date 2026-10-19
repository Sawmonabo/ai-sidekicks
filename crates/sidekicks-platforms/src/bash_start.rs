//! How bash starts as a terminal's login shell with the marks script loaded after the person's own
//! login files. Every bash but macOS's own starts in posix mode, which reads only the file `ENV`
//! names: the marks script, which turns posix mode off, puts the person's own `ENV` back and runs
//! their login files itself. macOS's own bash, which skips that read, starts its own way.

use sidekicks_contracts::machine::settings::SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME;

use crate::path::rules::PathRules;

/// What a bash start is decided from.
pub struct BashStartInput<'a> {
    /// The bash program the shell starts.
    pub shell_path: &'a str,
    /// The marks script, which also runs the person's login files where bash skipped them.
    pub script_path: &'a str,
    /// The environment the shell would start with.
    pub environment: &'a [(String, String)],
}

/// How one bash starts: the program, its arguments and the variables laid over its environment,
/// in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BashStart {
    /// The program started.
    pub program: String,
    /// Its arguments.
    pub arguments: Vec<String>,
    /// The variables set over the environment, a later one winning.
    pub pairs: Vec<(String, String)>,
}

/// How the bash `input` names starts on this system with the marks script loaded after the
/// person's login files: macOS's own `/bin/bash` through its first prompt command, every other
/// bash as a posix-mode login shell whose `ENV` names the script.
pub fn start_bash(input: &BashStartInput<'_>) -> BashStart {
    #[cfg(target_os = "macos")]
    if input.shell_path == crate::macos::bash_start::MACOS_OWN_BASH_PATH {
        return crate::macos::bash_start::start_macos_own_bash(input);
    }
    start_bash_through_env(input)
}

// A posix-mode login shell whose `ENV` names the marks script; the script puts the person's own
// `ENV` back, or erases it where none came.
fn start_bash_through_env(input: &BashStartInput<'_>) -> BashStart {
    let person_env = PathRules::NATIVE.environment_value(input.environment, "ENV");
    BashStart {
        program: input.shell_path.to_owned(),
        arguments: vec!["--posix".to_owned(), "-l".to_owned()],
        pairs: person_env
            .map(|value| {
                (
                    SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME.to_owned(),
                    value.to_owned(),
                )
            })
            .into_iter()
            .chain([("ENV".to_owned(), input.script_path.to_owned())])
            .collect(),
    }
}
