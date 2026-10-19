//! A running process as the system knows it, read after the process is pinned, so a process
//! given a freed id meanwhile is never read in its place: the process's id, the boot it runs in,
//! and the system's own record of when it started.

use std::io;

use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::BoundedText;

#[cfg(target_os = "linux")]
use crate::linux::pinned_process::pin_running_process;
#[cfg(target_os = "macos")]
use crate::macos::pinned_process::pinned as pin_running_process;
#[cfg(target_os = "windows")]
use crate::windows::pinned_process::pin_running_process;

/// The identity of process `pid`: pinned first, then its boot and its start read, which on macOS
/// is its start instant in microseconds, on Linux its start in clock ticks since boot and on
/// Windows its creation time; `None` when no process has the id or it ended before the read.
/// Fails with the system's error, and with `InvalidData` for a value past the identity's bounds.
pub fn process_identity(pid: u32) -> io::Result<Option<ProcessIdentity>> {
    let Some(process) = pin_running_process(pid)? else {
        return Ok(None);
    };
    let Some(record) = process.record()? else {
        return Ok(None);
    };
    let out_of_bounds = |what: &str| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("process {pid}'s {what} is past the identity's bounds"),
        )
    };
    let start = record.started_at.unwrap_or(record.start);
    Ok(Some(ProcessIdentity {
        process_id: SafeInt::new(u64::from(pid)).ok_or_else(|| out_of_bounds("id"))?,
        boot_id: BoundedText::new(record.boot).ok_or_else(|| out_of_bounds("boot"))?,
        process_start_time: BoundedText::new(start.to_string())
            .ok_or_else(|| out_of_bounds("start"))?,
    }))
}

#[cfg(test)]
mod tests {
    use super::process_identity;

    // Two reads of one process are equal, so a client compares the service's identity before each
    // signal; a process that has ended reads as none, so its freed id is never signaled.
    #[test]
    fn a_process_reads_the_same_identity_until_it_ends() {
        let ended_child = std::process::Command::new(std::env::current_exe().expect("a program"))
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("the child starts");
        let ended_id = ended_child.id();
        ended_child.wait_with_output().expect("the child is reaped");

        let first = process_identity(std::process::id()).expect("the read answers");
        let second = process_identity(std::process::id()).expect("the read answers");
        let ended = process_identity(ended_id).expect("the read answers");

        assert!(first.is_some());
        assert_eq!(first, second);
        assert_eq!(ended, None);
    }
}
