//! What macOS alone supplies: the machine's computer name, and no Windows drive mounts.

use std::io;
use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use crate::machine_name::{MachineNameError, require_machine_name};
use crate::posix::shell_start::arm_parent_death;
use crate::spawner::Spawner;

// The program that reads the computer name, by its full path so no `PATH` entry stands in for it.
const SCUTIL_PROGRAM: &str = "/usr/sbin/scutil";

// The computer name the person set in System Settings, never the host name, which reads
// `Name-Mac-mini.local`.
const COMPUTER_NAME_SOURCE: &str = "scutil --get ComputerName";

/// The computer name the person gave this Mac, read by `scutil` started on `spawner`'s thread and
/// trimmed. Fails with [`MachineNameError::Read`] when `scutil` cannot start or exits with a
/// failure, and with [`MachineNameError::Empty`] when the name is empty.
pub async fn machine_name(spawner: &Spawner) -> Result<String, MachineNameError> {
    let read_failure = |source: io::Error| MachineNameError::Read {
        source_name: COMPUTER_NAME_SOURCE,
        source,
    };
    let mut command = Command::new(SCUTIL_PROGRAM);
    command
        .args(["--get", "ComputerName"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The daemon can end between the fork and the exec, so the child checks it is still the parent.
    let daemon_pid = std::process::id();
    // SAFETY: the closure runs in the forked child before the exec and calls only
    // `arm_parent_death`, which is async-signal-safe and allocates nothing.
    unsafe {
        command.pre_exec(move || arm_parent_death(daemon_pid));
    }
    let child = spawner
        .run(move || command.spawn())
        .await
        .map_err(read_failure)?
        .map_err(read_failure)?;
    let output = child.wait_with_output().await.map_err(read_failure)?;
    if !output.status.success() {
        return Err(read_failure(io::Error::other(format!(
            "scutil exited with {}",
            output.status
        ))));
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    require_machine_name(name, COMPUTER_NAME_SOURCE)
}

/// The folders the Windows drives are mounted at inside a WSL distribution: none on macOS. Never
/// fails.
pub fn windows_drive_mounts() -> io::Result<Vec<PathBuf>> {
    Ok(Vec::new())
}
