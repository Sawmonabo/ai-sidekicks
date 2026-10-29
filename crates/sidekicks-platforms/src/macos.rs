//! What macOS alone supplies: the machine's computer name, no Windows drive mounts, reads through a
//! memory map, a local connection's caller pinned with its responsible process and its code
//! signature, the start as its own responsible process and the daemon's confirmation of a shell's
//! start, a lasting child's and a session child's start through `posix_spawn` and their reap, the
//! bound on a program's argument, a process's memory and the machine's available memory, one user's
//! processes and the arguments and environment a process started with, an open descriptor's path,
//! the wakes of a folder's and a file's watch, whether a terminal's program waits for input, the
//! machine's wakes from sleep, whether it runs on AC power, a wall-clock timer, the login keychain,
//! the Region setting's locale and hour cycle, the app's start with no window and the shells the
//! live test opens on a folder.

pub(crate) mod bash_start;
pub(crate) mod caller_process;
pub(crate) mod code_signature;
pub(crate) mod credential_store;
pub(crate) mod descriptor_path;
pub(crate) mod input_wait;
pub(crate) mod lasting_child;
pub(crate) mod loaded_images;
pub(crate) mod memory;
pub(crate) mod pinned_process;
pub(crate) mod power_source;
pub(crate) mod process_start;
pub(crate) mod processes;
pub(crate) mod responsibility;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod scratch_volume;
pub(crate) mod session_child;
pub(crate) mod shell_start_confirmation;
pub(crate) mod system_locale;
pub(crate) mod wake_watch;
pub(crate) mod wall_clock_timer;
pub(crate) mod watch;
pub(crate) mod windowless_app;

use std::io;
use std::path::PathBuf;
use std::process::Stdio;

use nix::unistd::SysconfVar;
use tokio::process::Command;

use crate::machine_name::{MachineNameError, require_machine_name};
use crate::posix::child_command::prepare_child_command;
#[cfg(any(test, feature = "test-support"))]
use crate::posix::shell_folder_start::BASH_SHELL_FOLDER_PROBE;
#[cfg(any(test, feature = "test-support"))]
use crate::shell_folder_start::ShellFolderProbe;
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
    prepare_child_command(&mut command, std::process::id());
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

/// Whether the daemon's credential store keeps its items in a file in the data folder: no, since
/// they go into the login keychain, the account's own.
pub const CREDENTIAL_STORE_LIVES_IN_THE_DATA_FOLDER: bool = false;

/// A bound in bytes that no single argument a program can start with reaches:
/// `sysconf(_SC_ARG_MAX)`, which counts the arguments and the environment together, never
/// `<limits.h>`'s smaller `ARG_MAX`. Fails with the system's error when the read fails, and with
/// `Other` when the system sets no limit or one past `usize`.
pub fn read_command_argument_limit() -> io::Result<usize> {
    let limit = nix::unistd::sysconf(SysconfVar::ARG_MAX)?
        .ok_or_else(|| io::Error::other("the system sets no limit on a program's arguments"))?;
    usize::try_from(limit).map_err(io::Error::other)
}

/// The shells the live test opens here, each with no startup files and a prompt of its folder:
/// macOS removes a folder a process sits in, so none leaves it first.
#[cfg(any(test, feature = "test-support"))]
pub const SHELL_FOLDER_PROBES: &[ShellFolderProbe] = &[
    ShellFolderProbe {
        program: "zsh",
        arguments: &["-f"],
        environment: &[("PS1", "%/>")],
        prompt_prefix: "",
        leaves_the_folder_first: false,
        folder_name: "worktree",
    },
    BASH_SHELL_FOLDER_PROBE,
];
