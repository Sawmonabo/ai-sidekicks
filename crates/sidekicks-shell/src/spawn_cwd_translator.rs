//! Moves a start's spawn folder off its worktree. Windows keeps a handle on every running
//! process's current folder, so a worktree a process was started in cannot be removed or moved
//! while the process holds it; a start is told its worktree the way its program lets go of that
//! folder again. It runs once per start, on a request whose shell folder is the worktree.

use std::path::{Path, PathBuf};

use sidekicks_platforms::{ShellFolderStart, shell_folder_start};
use sidekicks_terminal::{ShellCommand, SpawnRequest};

/// How the worktree path is carried to a start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnCwdStrategy {
    /// For starts that are themselves shells, the platforms crate's folder start: the `shell` mode
    /// is spawned in the stable folder on macOS and Linux and in the system folder on Windows, and
    /// starts the shell in the worktree, except PowerShell, WSL and `cmd.exe` on a share on
    /// Windows, which start in the system folder and are told the worktree by their own switch or
    /// command. A Windows folder start is taken only where the shell's own command line fits
    /// 32,767 UTF-16 units with its NUL; past that bound the shell starts in the worktree with its
    /// arguments unchanged.
    ShellFolder,
    /// Adds a `CWD` entry last, so it wins over an earlier one, and starts the mode and the
    /// program in the stable folder; for agent programs that read `CWD`.
    CwdEnvironment,
}

/// Why a start's working folder could not be moved off its worktree.
#[derive(Debug, thiserror::Error)]
pub enum SpawnCwdError {
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

/// `request`, whose shell's and fallback's folder is the worktree, each started per `strategy`,
/// `stable_parent` the folder a start that is told its worktree another way spawns in; each
/// launch's program, arguments, environment, folder and raw tail are its start's answer, applied
/// whole, and the `shell` mode spawns where the shell's start says. Fails with [`SpawnCwdError`]
/// on an empty `stable_parent` or a worktree path that is not UTF-8.
pub fn translate_spawn_cwd(
    request: SpawnRequest,
    strategy: SpawnCwdStrategy,
    stable_parent: &Path,
) -> Result<SpawnRequest, SpawnCwdError> {
    if stable_parent.as_os_str().is_empty() {
        return Err(SpawnCwdError::EmptyStableParent);
    }
    let (shell, spawn_folder) = translate_command(request.shell, strategy, stable_parent)?;
    let (fallback, _) = translate_command(request.fallback, strategy, stable_parent)?;
    Ok(SpawnRequest {
        shell,
        fallback,
        working_directory: spawn_folder,
        ..request
    })
}

// `command`, whose folder is the worktree, started per `strategy`, and the folder its start spawns
// the `shell` mode in.
fn translate_command(
    command: ShellCommand,
    strategy: SpawnCwdStrategy,
    stable_parent: &Path,
) -> Result<(ShellCommand, PathBuf), SpawnCwdError> {
    let ShellCommand {
        program,
        arguments,
        mut environment,
        folder,
        ..
    } = command;
    let folder =
        folder
            .into_os_string()
            .into_string()
            .map_err(|folder| SpawnCwdError::FolderNotText {
                folder: PathBuf::from(folder),
            })?;
    let start = match strategy {
        SpawnCwdStrategy::ShellFolder => {
            shell_folder_start(&program, &arguments, &folder, stable_parent)
        }
        SpawnCwdStrategy::CwdEnvironment => ShellFolderStart {
            program,
            arguments,
            spawn_folder: stable_parent.to_path_buf(),
            shell_folder: stable_parent.to_path_buf(),
            added_environment: vec![("CWD".to_owned(), folder)],
            raw_command_tail: None,
        },
    };
    environment.extend(start.added_environment);
    Ok((
        ShellCommand {
            program: start.program,
            arguments: start.arguments,
            environment,
            folder: start.shell_folder,
            raw_command_tail: start.raw_command_tail,
        },
        start.spawn_folder,
    ))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use sidekicks_platforms::{POSIX_SHELL, shell_folder_start};
    use sidekicks_terminal::{CommandLine, ShellCommand, SpawnRequest};

    use super::{SpawnCwdStrategy, translate_spawn_cwd};

    const WORKTREE: &str = "/work/it's 100%";

    fn command(program: &str, arguments: &[String], environment: &[(&str, &str)]) -> ShellCommand {
        ShellCommand {
            program: program.to_owned(),
            arguments: arguments.to_vec(),
            environment: environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
            folder: PathBuf::from(WORKTREE),
            raw_command_tail: None,
        }
    }

    fn request(program: &str, arguments: &[String], environment: &[(&str, &str)]) -> SpawnRequest {
        SpawnRequest {
            shell: command(program, arguments, environment),
            fallback: command(POSIX_SHELL, &[], environment),
            working_directory: PathBuf::from(WORKTREE),
            rows: 24,
            columns: 80,
            shell_start: CommandLine {
                program: "/daemon".to_owned(),
                arguments: vec!["shell".to_owned()],
            },
        }
    }

    // Fails when a shell's folder start is not applied whole (its program, arguments, both
    // folders, raw tail and added variables after the start's own), or an agent program keeps the
    // worktree as a folder instead of the `CWD` entry.
    #[test]
    fn translate_spawn_cwd_applies_the_shells_folder_start_and_the_cwd_entry() {
        let arguments = vec!["-Login".to_owned()];
        let stable = Path::new("/stable");
        let shell = translate_spawn_cwd(
            request("pwsh.exe", &arguments, &[("PATH", "/usr/bin")]),
            SpawnCwdStrategy::ShellFolder,
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
        let expected_shell = ShellCommand {
            program: folder_start.program,
            arguments: folder_start.arguments,
            environment: shell_environment,
            folder: folder_start.shell_folder,
            raw_command_tail: folder_start.raw_command_tail,
        };
        let mut expected_agent = command(
            "git",
            &arguments,
            &[("PATH", "/usr/bin"), ("CWD", WORKTREE)],
        );
        expected_agent.folder = stable.to_path_buf();
        assert_eq!(shell.shell, expected_shell);
        assert_eq!(shell.working_directory, folder_start.spawn_folder);
        assert_ne!(shell.working_directory, Path::new(WORKTREE));
        assert_eq!(agent.shell, expected_agent);
        assert_eq!(agent.working_directory, stable);
        // The fallback is told its worktree the same way as the shell.
        assert_eq!(agent.fallback.folder, stable);
    }
}
