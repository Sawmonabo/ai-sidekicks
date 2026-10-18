//! Moves a start's working folder off its worktree. Windows keeps a handle on every running
//! process's working folder, so a worktree a process was started in cannot be removed or moved
//! while the process holds it; a start is told its worktree the way its program lets go of that
//! folder again. It runs once per start: a second call wraps the start again.

use std::path::{Path, PathBuf};

use sidekicks_platforms::{ShellFolderStart, shell_folder_start};
use sidekicks_terminal::SpawnRequest;

/// How the worktree path is carried to a start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the terminal and agent starts choose how their worktree is told"
    )
)]
pub(crate) enum SpawnCwdStrategy {
    /// For starts that are themselves shells: the platforms crate's folder start for the shell's
    /// program. On macOS and Linux `sh` enters the worktree and runs the shell, spawned in the
    /// stable folder; on Windows PowerShell, WSL and `cmd.exe` on a share are spawned in the
    /// system folder and told the worktree by their own switch, and every other shell starts in
    /// the worktree, which it lets go of once it leaves.
    CdPrefix,
    /// Adds a `CWD` entry last, so it wins over an earlier one, and starts in the stable folder;
    /// for agent programs that read `CWD`.
    CwdEnvironment,
}

/// Why a start's working folder could not be moved off its worktree.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SpawnCwdError {
    /// The folder that never moves is empty, so the start would run in the daemon's own working
    /// folder.
    #[error("the folder a start runs in instead of its worktree is empty")]
    EmptyStableParent,
    /// The worktree path is not UTF-8, so it cannot be written into a command line or `CWD`.
    #[error("the worktree path {} is not text", folder.display())]
    FolderNotText {
        /// The worktree path.
        folder: PathBuf,
    },
}

/// `request` started per `strategy`, `stable_parent` the folder a start that is told its worktree
/// another way spawns in; only the program, arguments, environment and working folder change.
/// Fails with [`SpawnCwdError`] on an empty `stable_parent` or a worktree path that is not UTF-8.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the terminal and agent starts on a worktree move their folder through it"
    )
)]
pub(crate) fn translate_spawn_cwd(
    request: SpawnRequest,
    strategy: SpawnCwdStrategy,
    stable_parent: &Path,
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
    let start = match strategy {
        SpawnCwdStrategy::CdPrefix => {
            shell_folder_start(&program, &arguments, &folder, stable_parent)
        }
        SpawnCwdStrategy::CwdEnvironment => ShellFolderStart {
            program,
            arguments,
            spawn_folder: stable_parent.to_path_buf(),
            added_environment: vec![("CWD".to_owned(), folder)],
        },
    };
    environment.extend(start.added_environment);
    Ok(SpawnRequest {
        program: start.program,
        arguments: start.arguments,
        environment,
        working_directory: start.spawn_folder,
        rows,
        columns,
        shell_start,
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use sidekicks_platforms::shell_folder_start;
    use sidekicks_terminal::{CommandLine, SpawnRequest};

    use super::{SpawnCwdStrategy, translate_spawn_cwd};

    const WORKTREE: &str = "/work/it's 100%";

    fn request(program: &str, arguments: &[String], environment: &[(&str, &str)]) -> SpawnRequest {
        SpawnRequest {
            program: program.to_owned(),
            arguments: arguments.to_vec(),
            environment: environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
            working_directory: PathBuf::from(WORKTREE),
            rows: 24,
            columns: 80,
            shell_start: CommandLine {
                program: "/daemon".to_owned(),
                arguments: vec!["shell".to_owned()],
            },
        }
    }

    // Fails when a shell's folder start is not applied whole (its program, arguments, spawn folder
    // and added variables after the start's own), or an agent program keeps the worktree as its
    // working folder instead of the `CWD` entry.
    #[test]
    fn translate_spawn_cwd_applies_the_shells_folder_start_and_the_cwd_entry() {
        let arguments = vec!["-Login".to_owned()];
        let stable = Path::new("/stable");
        let shell = translate_spawn_cwd(
            request("pwsh.exe", &arguments, &[("PATH", "/usr/bin")]),
            SpawnCwdStrategy::CdPrefix,
            stable,
        )
        .expect("the stable folder is set and the worktree path is text");
        let agent = translate_spawn_cwd(
            request("git", &arguments, &[("PATH", "/usr/bin")]),
            SpawnCwdStrategy::CwdEnvironment,
            stable,
        )
        .expect("the stable folder is set and the worktree path is text");

        let folder_start = shell_folder_start("pwsh.exe", &arguments, WORKTREE, stable);
        let mut shell_environment = vec![("PATH".to_owned(), "/usr/bin".to_owned())];
        shell_environment.extend(folder_start.added_environment);
        let mut expected_shell = request(&folder_start.program, &folder_start.arguments, &[]);
        expected_shell.environment = shell_environment;
        expected_shell.working_directory = folder_start.spawn_folder;
        let mut expected_agent = request(
            "git",
            &arguments,
            &[("PATH", "/usr/bin"), ("CWD", WORKTREE)],
        );
        expected_agent.working_directory = stable.to_path_buf();
        assert_ne!(shell.working_directory, Path::new(WORKTREE));
        assert_eq!(shell, expected_shell);
        assert_eq!(agent, expected_agent);
    }
}
