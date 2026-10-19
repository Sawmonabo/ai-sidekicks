//! The daemon's hold on every process it starts, set before any child starts: on Windows a job the
//! daemon runs in whose last handle closing ends every process in it, the daemon's crash included;
//! on Linux the daemon takes in the orphans below it and keeps other processes of the account from
//! reading its memory, and each shell runs in a cgroup of its own the daemon ends whole. macOS has
//! neither, so its calls change nothing.

use std::io;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use crate::linux::process_containment as system;
#[cfg(target_os = "windows")]
use crate::windows::process_containment as system;

/// Puts the daemon's own process under its hold of every process it starts: on Windows a new job
/// that ends every process in it once its last handle closes and lets a child that asks leave it;
/// on Linux a child subreaper that no other process of the account may read; nothing on macOS.
/// Called once, before the first child starts. Fails with the system's error.
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
/// daemon made under its own delegated cgroup and moved the shell into; nothing elsewhere, where
/// the daemon-wide hold covers a shell.
pub struct ShellContainment {
    /// The shell's cgroup folder; `None` where none could be made.
    #[cfg(target_os = "linux")]
    cgroup: Option<PathBuf>,
}

impl ShellContainment {
    /// Moves the just-started shell process `shell_process_id` into a cgroup of its own, named for
    /// it, beside the daemon's own under the cgroup systemd delegated to the daemon's unit, so the
    /// shell execs already inside; nothing on macOS and Windows. A cgroup the system refuses, as
    /// where the daemon's unit was given no delegated cgroup, is logged, and the shell is then held
    /// only by the daemon-wide hold. Never fails.
    pub fn new(shell_process_id: u32) -> Self {
        #[cfg(target_os = "linux")]
        return Self {
            cgroup: system::move_into_own_cgroup(shell_process_id)
                .inspect_err(|error| {
                    tracing::warn!(
                        shell_process_id,
                        error = error as &(dyn std::error::Error + 'static),
                        "a shell could not be given a cgroup of its own"
                    );
                })
                .ok(),
        };
        #[cfg(not(target_os = "linux"))]
        {
            let _ = shell_process_id;
            Self {}
        }
    }
}

impl Drop for ShellContainment {
    // Ends every process left in the shell's cgroup and removes it; a failure is logged, since
    // the shell's own end has already run.
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = self.cgroup.take() {
            system::end_cgroup(&cgroup);
        }
    }
}
