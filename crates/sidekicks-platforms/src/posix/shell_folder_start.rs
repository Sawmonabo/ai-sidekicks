//! A shell's folder start on macOS and Linux, which hold no folder against its removal: the
//! `shell` mode enters the folder before it runs the shell.

use std::path::{Path, PathBuf};

#[cfg(any(test, feature = "test-support"))]
use crate::shell_folder_start::ShellFolderProbe;
use crate::shell_folder_start::ShellFolderStart;

/// The `bash` the live test opens on macOS and Linux, with no startup files and a prompt of its
/// folder; neither system holds the folder against removal, so it does not leave it first.
#[cfg(any(test, feature = "test-support"))]
pub(crate) const BASH_SHELL_FOLDER_PROBE: ShellFolderProbe = ShellFolderProbe {
    program: "bash",
    arguments: &["--norc", "--noprofile"],
    environment: &[("PS1", "$PWD>")],
    prompt_prefix: "",
    leaves_the_folder_first: false,
    folder_name: "worktree",
};

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
