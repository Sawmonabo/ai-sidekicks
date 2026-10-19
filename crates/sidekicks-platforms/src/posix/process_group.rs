//! A signal to a whole process group on macOS and Linux, which tells a group that has ended from a
//! refused send, and on macOS repeats a kill until no member is left.

use std::io::{self, ErrorKind};
use std::time::{Duration, Instant};

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

/// How long a macOS group kill repeats while members are left, before it fails.
const GROUP_KILL_BOUND: Duration = Duration::from_secs(1);

/// Sends `signal` to every member of the group process `id` leads, a `SIGKILL` on macOS again
/// until no member is left; `false` when the group had already ended. Fails with `InvalidInput`
/// for an id past `i32::MAX`, with `TimedOut` naming the members a kill leaves past
/// [`GROUP_KILL_BOUND`], else with the system's error.
pub(crate) fn signal_group(id: u32, signal: Signal) -> io::Result<bool> {
    let group = Pid::from_raw(
        libc::pid_t::try_from(id)
            .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?,
    );
    // macOS's kill reaches only the members fully made as it lists them, so a child forked
    // meanwhile outlives it; Linux's reaches every member, a fork under way included.
    let is_repeated = cfg!(target_os = "macos") && signal == Signal::SIGKILL;
    let give_up_at = Instant::now() + GROUP_KILL_BOUND;
    let mut is_signaled = false;
    loop {
        match killpg(group, signal) {
            Ok(()) => is_signaled = true,
            Err(Errno::ESRCH) => return Ok(is_signaled),
            // macOS refuses a group whose members have all exited but are not yet reaped, and
            // one whose only running member is still being made, which the kill skips.
            #[cfg(target_os = "macos")]
            Err(Errno::EPERM) => {
                if live_group_members(id)?.is_empty() {
                    return Ok(is_signaled);
                }
                if !is_repeated {
                    return Err(io::Error::from(Errno::EPERM));
                }
            }
            Err(errno) => return Err(io::Error::from(errno)),
        }
        if !is_repeated {
            return Ok(true);
        }
        if Instant::now() >= give_up_at {
            let members = live_group_members(id)?;
            if members.is_empty() {
                return Ok(is_signaled);
            }
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                format!("process group {id} keeps members {members:?} after its kill"),
            ));
        }
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

/// Reads `output` to its end, which comes once every process holding the pipe's other end has
/// ended; when it has not come within `bound`, kills group `group_id`, the test's own child's,
/// and answers `None`.
#[cfg(test)]
pub(crate) fn read_group_output_to_end(
    output: &mut std::process::ChildStdout,
    group_id: u32,
    bound: Duration,
) -> Option<Vec<u8>> {
    let read = read_to_end_within(output, bound).expect("the output reads");
    if read.is_none() {
        let group = Pid::from_raw(libc::pid_t::try_from(group_id).expect("a process id fits"));
        // Bounded, since a group that forks as it is killed can answer each kill.
        for _ in 0..1_000 {
            if killpg(group, Signal::SIGKILL).is_err() {
                break;
            }
        }
        read_to_end_within(output, bound).expect("the output reads after the group's end");
    }
    read
}

// Reads `output` to its end; `None` when the end has not come within `bound`.
#[cfg(test)]
fn read_to_end_within(
    output: &mut std::process::ChildStdout,
    bound: Duration,
) -> io::Result<Option<Vec<u8>>> {
    use std::io::Read as _;
    use std::os::fd::{AsFd as _, AsRawFd as _};

    use polling::{Event, Poller};

    use crate::posix::process_stop::wait_for_event;

    let poller = Poller::new()?;
    // SAFETY: `output` outlives the poller, which this call drops.
    unsafe { poller.add(output.as_raw_fd(), Event::readable(0)) }?;
    let give_up_at = Instant::now() + bound;
    let mut read = Vec::new();
    loop {
        if !wait_for_event(
            &poller,
            give_up_at.saturating_duration_since(Instant::now()),
        )? {
            return Ok(None);
        }
        let mut chunk = [0; 4096];
        let count = output.read(&mut chunk)?;
        if count == 0 {
            return Ok(Some(read));
        }
        read.extend_from_slice(&chunk[..count]);
        poller.modify(output.as_fd(), Event::readable(0))?;
    }
}

#[cfg(test)]
mod tests {
    // Fails on macOS when the group's kill is sent once, which leaves a child the group forked as
    // it was killed running and holding the group's output open.
    #[cfg(target_os = "macos")]
    #[test]
    fn process_group_kill_ends_a_group_forking_as_it_is_killed() {
        use std::hash::{BuildHasher as _, RandomState};
        use std::os::unix::process::CommandExt as _;
        use std::process::{Command, Stdio};
        use std::time::Duration;

        use nix::sys::signal::Signal;

        use super::{read_group_output_to_end, signal_group};

        let mut survived_trials = Vec::new();
        for trial in 0..20_u64 {
            let mut child = Command::new("/bin/sh")
                .args(["-c", "for i in $(seq 300); do /bin/sleep 30 & done; wait"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .process_group(0)
                .spawn()
                .expect("the group's leader starts");
            let mut output = child.stdout.take().expect("the leader's output is piped");
            let wait = 5 + RandomState::new().hash_one(trial) % 46;
            std::thread::sleep(Duration::from_millis(wait));

            let is_signaled =
                signal_group(child.id(), Signal::SIGKILL).expect("the group's kill is sent");
            let rest = read_group_output_to_end(&mut output, child.id(), Duration::from_secs(2));
            child.wait().expect("the leader is reaped");

            assert!(is_signaled);
            if rest.is_none() {
                survived_trials.push(trial);
            }
        }
        assert_eq!(survived_trials, Vec::<u64>::new());
    }
}
