//! How a shell is started so that it opens in a folder: the program and arguments, the folder the
//! `shell` mode is spawned in, the folder the mode hands the shell, and the environment entries it
//! is given. Windows keeps a handle on every process's current folder, so a folder that must stay
//! removable is told to the shell another way where the shell would hold it for its life.

use std::path::PathBuf;

#[cfg(any(target_os = "windows", test))]
pub(crate) mod windows;

/// How one shell is started so that it opens in its folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellFolderStart {
    /// The program the system starts.
    pub program: String,
    /// Its whole argument list, each argument quoted by the C runtime's rules on Windows.
    pub arguments: Vec<String>,
    /// The folder the PTY spawns the `shell` mode in.
    pub spawn_folder: PathBuf,
    /// The folder the `shell` mode starts the shell in.
    pub shell_folder: PathBuf,
    /// The environment entries added after the start's own, so they win.
    pub added_environment: Vec<(String, String)>,
    /// Text the shell parses itself, written after the arguments exactly as given; only Windows
    /// fills it.
    pub raw_command_tail: Option<String>,
}

/// A shell the live test opens on a worktree on this host to prove the worktree stays removable
/// while the shell is open.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy, Debug)]
pub struct ShellFolderProbe {
    /// The program, found on `PATH`.
    pub program: &'static str,
    /// Its arguments, which keep the prompt to the probe's own.
    pub arguments: &'static [&'static str],
    /// Environment entries that replace the test's own of the same name.
    pub environment: &'static [(&'static str, &'static str)],
    /// What the prompt shows before the folder, which `>` follows.
    pub prompt_prefix: &'static str,
    /// Whether the shell holds the folder until it leaves it with `cd ..`.
    pub leaves_the_folder_first: bool,
}
