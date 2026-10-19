//! The daemon's hold on every process it starts, set before any child starts: on Windows a job the
//! daemon runs in whose last handle closing ends every process in it, the daemon's crash included,
//! and a job of its own for each shell; on Linux the daemon takes in the orphans below it and keeps
//! other processes of the account from reading its memory, and each shell runs in a cgroup of its
//! own the daemon ends whole where its cgroup was delegated to it. macOS has neither, so its calls
//! change nothing.

use std::io;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use crate::linux::process_containment as system;
#[cfg(target_os = "windows")]
use crate::windows::process_containment as system;

/// Puts the daemon's own process under its hold of every process it starts: on Windows a new job
/// that ends every process in it once its last handle closes and lets a child that asks leave it,
/// unless an outer job refuses it; on Linux a child subreaper that no other process of the account
/// may read, and its delegated cgroup taken for the shells' cgroups where it has one; nothing on
/// macOS. A hold the system leaves out is logged once. Called once, before the first child starts.
/// Fails with the system's error.
pub fn contain_daemon_descendants() -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    return system::contain_daemon_descendants();
    #[cfg(target_os = "macos")]
    Ok(())
}

/// The folder the daemon works in for its whole life, set at its start before any child or
/// terminal host starts, so a child that inherits it holds no folder a person may remove: `/` on
/// macOS and Linux, the system folder on Windows.
pub fn stable_working_folder() -> PathBuf {
    #[cfg(unix)]
    return PathBuf::from("/");
    #[cfg(target_os = "windows")]
    crate::windows::known_folder::system_folder()
}

/// One shell's own hold, which ends the shell's whole tree when it drops: on Linux the cgroup the
/// daemon made in its own delegated cgroup and moved the shell into, ended off the runtime's
/// workers; on Windows a job of its own, nested in the daemon's, that lets nothing leave it;
/// nothing on macOS, or where the daemon runs without its own hold, which its start logged.
pub struct ShellContainment {
    /// The shell's cgroup; `None` where none could be made.
    #[cfg(target_os = "linux")]
    _cgroup: Option<crate::linux::process_containment::ShellCgroup>,
    /// The shell's job; `None` where none could be made.
    #[cfg(target_os = "windows")]
    _job: Option<crate::windows::process_containment::ShellJob>,
}

impl ShellContainment {
    /// Puts the just-started `shell` mode `shell_process_id` in its own hold before its launch is
    /// written, so the shell starts already inside: on Linux a cgroup named for it beside the
    /// daemon's own leaf, on Windows a job of its own; nothing on macOS. A hold the system refuses
    /// is logged, and the shell is then held only by the daemon-wide hold. Never fails.
    pub fn new(shell_process_id: u32) -> Self {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        let held = system::contain_shell(shell_process_id)
            .inspect_err(|error| {
                tracing::warn!(
                    shell_process_id,
                    error = error as &(dyn std::error::Error + 'static),
                    "a shell could not be given a hold of its own"
                );
            })
            .ok()
            .flatten();
        #[cfg(target_os = "linux")]
        return Self { _cgroup: held };
        #[cfg(target_os = "windows")]
        return Self { _job: held };
        #[cfg(target_os = "macos")]
        {
            let _ = shell_process_id;
            Self {}
        }
    }
}

/// Ends what a previous run left of its shells' own holds, before any shell of this run starts: on
/// Linux every `shell-*` cgroup in the daemon's delegated cgroup, killing what still runs in one
/// and removing it; nothing elsewhere, where a shell's hold ends with the daemon. Blocking; a
/// failure is logged.
pub fn end_leftover_shell_containments() {
    #[cfg(target_os = "linux")]
    system::end_leftover_shell_cgroups();
}
