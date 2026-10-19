//! A shell's folder start on Windows, read with the system folder Windows reports.

use std::path::Path;

use crate::shell_folder_start::ShellFolderStart;
use crate::shell_folder_start::windows::compose_shell_folder_start;
use crate::windows::known_folder::system_folder;

/// How `program` with `arguments` starts in `folder`: the `shell` mode is spawned in the system
/// folder, where Windows Terminal keeps itself; PowerShell, `wsl.exe` and `cmd.exe` on a share
/// (which it refuses as its start folder) start there too where they can be told the folder by
/// their own means, and every other shell starts in `folder`. `_stable_folder` is the macOS and
/// Linux spawn folder, which Windows does not use. Reads the system folder, its usual path where
/// that read fails (logged); never fails.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    _stable_folder: &Path,
) -> ShellFolderStart {
    compose_shell_folder_start(program, arguments, folder, &system_folder())
}
