//! Moves a start's working folder off its worktree. Windows locks a running process's working
//! folder for the process's life, so a worktree with a shell running in it cannot be removed or
//! moved; the start runs in a folder that never moves instead and carries the worktree path in its
//! command line or its environment. It runs once per start: a second call wraps the start again.

use std::path::{Path, PathBuf};

use sidekicks_platforms::PathRules;
use sidekicks_terminal::SpawnRequest;

/// How the worktree path is carried once the start's working folder is replaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SpawnCwdStrategy {
    /// Wraps the start in `sh`, which enters the worktree and then runs the start; for starts that
    /// are themselves shells. Where the place has no such wrapper (Windows), the shell starts with
    /// a `CWD` entry its shell integration reads at startup, carried as
    /// [`SpawnCwdStrategy::CwdEnvironment`] carries it.
    CdPrefix,
    /// Adds a `CWD` entry last, so it wins over an earlier one; for agent programs that read `CWD`.
    CwdEnvironment,
}

/// Why a start's working folder could not be moved off its worktree.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SpawnCwdError {
    /// The folder that never moves is empty, so Windows would start the process in the daemon's
    /// own working folder and the lock the move avoids would return.
    #[error("the folder a start runs in instead of its worktree is empty")]
    EmptyStableParent,
    /// The worktree path is not UTF-8, so it cannot be written into a command line or `CWD`.
    #[error("the worktree path {} is not text", folder.display())]
    FolderNotText {
        /// The worktree path.
        folder: PathBuf,
    },
}

/// `request` started in `stable_parent`, carrying its own working folder per `strategy`, `rules`
/// being the place's (the WSL server's are Linux's); only the program, arguments, environment and
/// working folder change. Fails with [`SpawnCwdError`] on an empty `stable_parent` or a worktree
/// path that is not UTF-8.
pub(crate) fn translate_spawn_cwd(
    request: SpawnRequest,
    strategy: SpawnCwdStrategy,
    stable_parent: &Path,
    rules: PathRules,
) -> Result<SpawnRequest, SpawnCwdError> {
    if stable_parent.as_os_str().is_empty() {
        return Err(SpawnCwdError::EmptyStableParent);
    }
    let SpawnRequest {
        program,
        arguments,
        mut environment,
        working_directory,
        rows,
        columns,
        shell_start,
    } = request;
    let folder = working_directory
        .into_os_string()
        .into_string()
        .map_err(|folder| SpawnCwdError::FolderNotText {
            folder: PathBuf::from(folder),
        })?;
    let folder_command = match strategy {
        SpawnCwdStrategy::CdPrefix => rules.run_in_folder(&folder, &program, &arguments),
        SpawnCwdStrategy::CwdEnvironment => None,
    };
    let (program, arguments) = match folder_command {
        Some(command) => (command.program.to_owned(), command.arguments),
        None => {
            environment.push(("CWD".to_owned(), folder));
            (program, arguments)
        }
    };
    Ok(SpawnRequest {
        program,
        arguments,
        environment,
        working_directory: stable_parent.to_path_buf(),
        rows,
        columns,
        shell_start,
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::PathRules;
    use sidekicks_terminal::{CommandLine, SpawnRequest};

    use super::{SpawnCwdStrategy, translate_spawn_cwd};

    fn request(program: &str, arguments: &[&str], environment: &[(&str, &str)]) -> SpawnRequest {
        SpawnRequest {
            program: program.to_owned(),
            arguments: arguments
                .iter()
                .map(|&argument| argument.to_owned())
                .collect(),
            environment: environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
            working_directory: PathBuf::from("/work/it's 100%"),
            rows: 24,
            columns: 80,
            shell_start: CommandLine {
                program: "/daemon".to_owned(),
                arguments: vec!["shell".to_owned()],
            },
        }
    }

    // Fails when the worktree stays the working folder, the worktree path goes unquoted, or
    // Windows gets a wrapper instead of the `CWD` entry.
    #[rstest]
    #[case::cd_prefix(
        SpawnCwdStrategy::CdPrefix,
        PathRules::Posix,
        "/bin/sh",
        &["-c", r"cd '/work/it'\''s 100%' && exec 'git' 'status'"],
        &[("PATH", "/usr/bin")]
    )]
    #[case::cd_prefix_on_windows(
        SpawnCwdStrategy::CdPrefix,
        PathRules::Windows,
        "git",
        &["status"],
        &[("PATH", "/usr/bin"), ("CWD", "/work/it's 100%")]
    )]
    #[case::cwd_environment(
        SpawnCwdStrategy::CwdEnvironment,
        PathRules::Posix,
        "git",
        &["status"],
        &[("PATH", "/usr/bin"), ("CWD", "/work/it's 100%")]
    )]
    fn translate_spawn_cwd_starts_in_the_stable_folder_and_carries_the_worktree(
        #[case] strategy: SpawnCwdStrategy,
        #[case] rules: PathRules,
        #[case] program: &str,
        #[case] arguments: &[&str],
        #[case] environment: &[(&str, &str)],
    ) {
        let translated = translate_spawn_cwd(
            request("git", &["status"], &[("PATH", "/usr/bin")]),
            strategy,
            Path::new("/stable"),
            rules,
        )
        .expect("the stable folder is set and the worktree path is text");
        let mut expected = request(program, arguments, environment);
        expected.working_directory = PathBuf::from("/stable");
        assert_eq!(translated, expected);
    }
}
