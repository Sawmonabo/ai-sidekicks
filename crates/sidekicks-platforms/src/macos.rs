//! What macOS alone supplies: the machine's computer name, no Windows drive mounts, reads through a
//! memory map, a local connection's caller pinned with its responsible process and its code
//! signature, the start as its own responsible process and the daemon's confirmation of a shell's
//! start, the bound on a program's argument, the process's footprint, the machine's wakes from
//! sleep and a wall-clock timer.

pub(crate) mod caller_process;
pub(crate) mod code_signature;
pub(crate) mod responsibility;
pub(crate) mod shell_start_confirmation;
pub(crate) mod wake_watch;
pub(crate) mod wall_clock_timer;

use std::io;
use std::path::PathBuf;
use std::process::Stdio;

use nix::unistd::SysconfVar;
use tokio::process::Command;

#[cfg(any(test, feature = "test-support"))]
use crate::footprint::ProcessFootprint;
use crate::machine_name::{MachineNameError, require_machine_name};
use crate::posix::shell_start::arm_parent_death;
use crate::spawner::Spawner;

// The program that reads the computer name, by its full path so no `PATH` entry stands in for it.
const SCUTIL_PROGRAM: &str = "/usr/sbin/scutil";

// The program that prints the process's footprint, by its full path for the same reason.
#[cfg(any(test, feature = "test-support"))]
const FOOTPRINT_PROGRAM: &str = "/usr/bin/footprint";

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

/// Whether a reader that keeps a file open reads it through a memory map rather than by reads at
/// an offset: yes, since macOS's footprint (the memory it charges a process) leaves out a mapped
/// file's clean pages, so a mapped file measures smaller.
pub const SHOULD_MEMORY_MAP_READS: bool = true;

/// A bound in bytes that no single argument a program can start with reaches:
/// `sysconf(_SC_ARG_MAX)`, which counts the arguments and the environment together, never
/// `<limits.h>`'s smaller `ARG_MAX`. Fails with the system's error when the read fails, and with
/// `Other` when the system sets no limit or one past `usize`.
pub fn read_command_argument_limit() -> io::Result<usize> {
    let limit = nix::unistd::sysconf(SysconfVar::ARG_MAX)?
        .ok_or_else(|| io::Error::other("the system sets no limit on a program's arguments"))?;
    usize::try_from(limit).map_err(io::Error::other)
}

/// This process's footprint. Fails with the system's error when macOS refuses the read.
#[cfg(any(test, feature = "test-support"))]
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    let process = std::process::id();
    // SAFETY: `rusage_info_v4` is a C struct of integers, for which all zero bytes are valid.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let buffer = (&raw mut info).cast::<libc::rusage_info_t>();
    let pid = libc::pid_t::try_from(process).map_err(io::Error::other)?;
    // SAFETY: `buffer` points at a live `rusage_info_v4`, the struct `RUSAGE_INFO_V4` asks the call
    // to fill, and nothing else reads it until the call returns.
    let status = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, buffer) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    let tool_line = match std::process::Command::new(FOOTPRINT_PROGRAM)
        .arg("-p")
        .arg(process.to_string())
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .find(|line| line.contains("Footprint:"))
            .map_or_else(
                || "no footprint line".to_string(),
                |line| line.trim().to_string(),
            ),
        Err(error) => format!("footprint did not run: {error}"),
    };
    Ok(ProcessFootprint {
        current_bytes: info.ri_phys_footprint,
        peak_bytes: info.ri_lifetime_max_phys_footprint,
        tool_line,
    })
}
