//! A shell's folder start on macOS and Linux, which hold no folder against its removal: the
//! `shell` mode enters the folder before it runs the shell.

use std::path::{Path, PathBuf};

use crate::shell_folder_start::ShellFolderStart;

/// How `program` with `arguments` starts in `folder`: unchanged, the `shell` mode spawned in
/// `stable_folder` and handing the shell `folder`, which it enters before its exec.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    stable_folder: &Path,
) -> ShellFolderStart {
    ShellFolderStart {
        program: program.to_owned(),
        arguments: arguments.to_vec(),
        spawn_folder: stable_folder.to_path_buf(),
        shell_folder: PathBuf::from(folder),
        added_environment: Vec::new(),
        raw_command_tail: None,
    }
}
