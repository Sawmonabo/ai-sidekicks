//! A signal to a whole process group on macOS and Linux, which tells a group that has ended from a
//! refused send.

use std::io::{self, ErrorKind};
#[cfg(target_os = "macos")]
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

#[cfg(target_os = "macos")]
use crate::macos::pinned_process::pinned;
#[cfg(target_os = "macos")]
use crate::macos::processes::list_group_process_ids;

/// How long a group listing that found no live member waits before it lists again, so a member
/// still being made, which reads as no process, is seen.
#[cfg(target_os = "macos")]
const LISTING_GAP: Duration = Duration::from_millis(10);

/// Sends `signal` to every member of the group process `id` leads; `false` when the group has
/// ended. Fails with `InvalidInput` for an id past `i32::MAX`, else with the system's error.
pub(crate) fn signal_group(id: u32, signal: Signal) -> io::Result<bool> {
    let group = Pid::from_raw(
        libc::pid_t::try_from(id)
            .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?,
    );
    match killpg(group, signal) {
        Ok(()) => Ok(true),
        Err(Errno::ESRCH) => Ok(false),
        // macOS refuses a group whose members have all exited but are not yet reaped.
        #[cfg(target_os = "macos")]
        Err(Errno::EPERM) if live_group_members(id)?.is_empty() => Ok(false),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

/// The members of group `id` that still run, listed again after [`LISTING_GAP`] when the first
/// listing finds none. Fails with the system's error.
#[cfg(target_os = "macos")]
fn live_group_members(id: u32) -> io::Result<Vec<u32>> {
    let members = list_live_group_members(id)?;
    if !members.is_empty() {
        return Ok(members);
    }
    std::thread::sleep(LISTING_GAP);
    list_live_group_members(id)
}

// The members of group `id` the system reads as running; an exited member, and one still being
// made, reads as no process.
#[cfg(target_os = "macos")]
fn list_live_group_members(id: u32) -> io::Result<Vec<u32>> {
    let mut members = Vec::new();
    for member in list_group_process_ids(id)? {
        if pinned(member)?.is_some() {
            members.push(member);
        }
    }
    Ok(members)
}
