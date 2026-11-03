//! A running process as the system knows it, read after the process is pinned, so a process
//! given a freed id meanwhile is never read in its place: the process's id, the boot it runs in,
//! and the system's own record of when it started.

use std::io;

use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::BoundedText;

use crate::PinnedProcess;

#[cfg(target_os = "linux")]
use crate::linux::pinned_process::pin_running_process;
#[cfg(target_os = "macos")]
use crate::macos::pinned_process::pin_running_process;
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
    read_identity(&process)
}

/// The process `identity` names, pinned: its id pinned first, then its boot and start read through
/// the pin and compared with the identity's; `None` when no process has the id or the process
/// holding it now is another, so a freed id given to a new process is never signaled. Fails as
/// [`process_identity`] fails.
pub fn pin_identified_process(identity: &ProcessIdentity) -> io::Result<Option<PinnedProcess>> {
    // An id past the system's range names no process.
    let Ok(pid) = u32::try_from(identity.process_id.get()) else {
        return Ok(None);
    };
    let Some(process) = pin_running_process(pid)? else {
        return Ok(None);
    };
    let is_identified = read_identity(&process)?.as_ref() == Some(identity);
    Ok(is_identified.then_some(process))
}

// The identity of `process`, read through its pin; `None` once it has ended.
fn read_identity(process: &PinnedProcess) -> io::Result<Option<ProcessIdentity>> {
    let Some(record) = process.record()? else {
        return Ok(None);
    };
    let pid = process.id();
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

    // Fails when the pin skips the comparison and answers the process by its id alone, which then
    // signals a process the identity does not name, here a child whose start differs.
    #[cfg(unix)]
    #[test]
    fn an_identity_whose_start_differs_pins_no_process() {
        use sidekicks_contracts::wire::text::BoundedText;

        use super::pin_identified_process;

        // Ends the sleeper, pass or fail.
        struct Sleeper(std::process::Child);
        impl Drop for Sleeper {
            fn drop(&mut self) {
                if let Err(error) = self.0.kill().and_then(|()| self.0.wait().map(drop)) {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "the test's sleeper could not be ended"
                    );
                }
            }
        }

        let mut sleeper = Sleeper(
            std::process::Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .expect("the sleeper starts"),
        );
        let identity = process_identity(sleeper.0.id())
            .expect("the read answers")
            .expect("the sleeper runs");
        let other_start = format!("{}0", identity.process_start_time.as_str());
        let reused = sidekicks_contracts::process_identity::ProcessIdentity {
            process_start_time: BoundedText::new(other_start).expect("the start is in bounds"),
            ..identity
        };

        let pinned = pin_identified_process(&reused).expect("the pin answers");
        // The caller ends only what the pin answers.
        if let Some(process) = &pinned {
            process.kill().expect("the kill is sent");
        }
        let status = sleeper.0.try_wait().expect("the sleeper's state reads");

        assert!(
            pinned.is_none(),
            "a process the identity does not name was pinned"
        );
        assert!(status.is_none(), "the sleeper was signaled");
    }
}
