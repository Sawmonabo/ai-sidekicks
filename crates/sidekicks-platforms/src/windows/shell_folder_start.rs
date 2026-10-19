//! A shell's folder start on Windows, read with the system folder Windows reports.

use std::path::Path;

#[cfg(any(test, feature = "test-support"))]
use crate::shell_folder_start::ShellFolderProbe;
use crate::shell_folder_start::ShellFolderStart;
use crate::shell_folder_start::windows::compose_shell_folder_start;
use crate::windows::known_folder::system_folder;

/// How `program` with `arguments` starts in `folder`: the `shell` mode is spawned in the system
/// folder (its usual path where that read fails, logged; `_stable_folder` is unused here), where
/// PowerShell, `wsl.exe` and `cmd.exe` on a share start too, told the folder by their own means,
/// and every other shell starts in `folder`; never fails. A folder start is taken only where the
/// shell's own command line, its program, arguments and raw tail, fits 32,767 UTF-16 units with
/// its NUL; past that bound the shell starts in `folder` with its arguments unchanged.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    _stable_folder: &Path,
) -> ShellFolderStart {
    compose_shell_folder_start(program, arguments, folder, &system_folder())
}

/// The shells the live test opens here with their own prompts: cmd holds its folder until it
/// leaves it, and PowerShell, told its folder by pwsh's switch or Windows PowerShell's command,
/// never holds it; Windows PowerShell opens on a folder whose name holds a quote it reads as its
/// own.
#[cfg(any(test, feature = "test-support"))]
pub const SHELL_FOLDER_PROBES: &[ShellFolderProbe] = &[
    ShellFolderProbe {
        program: "cmd.exe",
        arguments: &[],
        environment: &[],
        prompt_prefix: "",
        leaves_the_folder_first: true,
        folder_name: "worktree",
    },
    ShellFolderProbe {
        program: "pwsh.exe",
        arguments: &[],
        environment: &[],
        prompt_prefix: "PS ",
        leaves_the_folder_first: false,
        folder_name: "worktree",
    },
    ShellFolderProbe {
        program: "powershell.exe",
        arguments: &[],
        environment: &[],
        prompt_prefix: "PS ",
        leaves_the_folder_first: false,
        folder_name: "a\u{2019}b",
    },
];
