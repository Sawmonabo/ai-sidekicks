//! A signal to a whole process group on macOS and Linux, which tells a group that has ended from a
//! refused send, and on macOS repeats a kill until no member is left.

use std::io;
#[cfg(any(target_os = "macos", test))]
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

#[cfg(target_os = "macos")]
use crate::macos::pinned_process::pin_running_process;
#[cfg(target_os = "macos")]
use crate::macos::processes::list_group_process_ids;
use crate::posix::process::id::system_process_id;

/// How long a group listing that found no live member waits before it lists again. It narrows the
/// one case the first listing cannot see: a spawned child still being made whose parent died
/// mid-spawn, which leaves the kill refused with no live member listed.
#[cfg(target_os = "macos")]
const LISTING_GAP: Duration = Duration::from_millis(10);

/// How long a macOS group kill repeats while members are left, before it fails.
#[cfg(target_os = "macos")]
const GROUP_KILL_BOUND: Duration = Duration::from_secs(1);

/// Whether a group's `SIGKILL` is sent again until no member is left, which can sleep between
/// listings: on macOS, whose kill reaches only the members fully made as it lists them, so a child
/// forked meanwhile outlives it; Linux's reaches every member, a fork under way included.
pub(crate) const IS_GROUP_KILL_REPEATED: bool = cfg!(target_os = "macos");

/// Sends `signal` to every member of the group process `id` leads, a `SIGKILL` on macOS again
/// until no member is left; `false` when the group had already ended, its members all exited.
/// Fails with `EPERM` when a refused send leaves members running, for a repeated kill only once
/// two refused kills list no new member, with `InvalidInput` for an id of 0 or past `i32::MAX`,
/// with `TimedOut` naming the members a macOS kill leaves past its bound, else with the system's
/// error.
pub(crate) fn signal_group(id: u32, signal: Signal) -> io::Result<bool> {
    let group = Pid::from_raw(system_process_id(id)?.get());
    let is_repeated = IS_GROUP_KILL_REPEATED && signal == Signal::SIGKILL;
    #[cfg(target_os = "macos")]
    let give_up_at = Instant::now() + GROUP_KILL_BOUND;
    // The live members the last refused kill listed, kept across the kills that reach some.
    #[cfg(target_os = "macos")]
    let mut refused_members: Vec<u32> = Vec::new();
    let mut is_signaled = false;
    loop {
        match killpg(group, signal) {
            Ok(()) => is_signaled = true,
            Err(Errno::ESRCH) => return Ok(is_signaled),
            // macOS refuses a group whose members have all exited but are not yet reaped, which
            // has ended, and one whose running members all refuse this sender. A kill refused
            // twice with no new member listed refuses this sender; a new member, a child made
            // visible since the listing before, is killed again.
            #[cfg(target_os = "macos")]
            Err(Errno::EPERM) => {
                let members = live_group_members(id)?;
                if members.is_empty() {
                    return Ok(is_signaled);
                }
                if !is_repeated
                    || members
                        .iter()
                        .all(|member| refused_members.contains(member))
                {
                    return Err(io::Error::from(Errno::EPERM));
                }
                if Instant::now() >= give_up_at {
                    return Err(members_left_error(id, &members));
                }
                refused_members = members;
                continue;
            }
            Err(errno) => return Err(io::Error::from(errno)),
        }
        if !is_repeated {
            return Ok(true);
        }
        #[cfg(target_os = "macos")]
        if Instant::now() >= give_up_at {
            let members = live_group_members(id)?;
            if members.is_empty() {
                return Ok(is_signaled);
            }
            return Err(members_left_error(id, &members));
        }
    }
}

/// Sends `signal` once to every member of the group process `id` leads, never listing or sleeping;
/// `false` when the group had already ended. Fails with `InvalidInput` for an id of 0 or past
/// `i32::MAX`, else with the system's error, `EPERM` among them.
pub(crate) fn signal_group_once(id: u32, signal: Signal) -> io::Result<bool> {
    let group = Pid::from_raw(system_process_id(id)?.get());
    match killpg(group, signal) {
        Ok(()) => Ok(true),
        Err(Errno::ESRCH) => Ok(false),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

// The failure of a kill of group `id` that leaves `members` running past its bound.
#[cfg(target_os = "macos")]
fn members_left_error(id: u32, members: &[u32]) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("process group {id} keeps members {members:?} after its kill"),
    )
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

// The members of group `id` that `pin_running_process` answers for, which are the live ones: its
// lookup goes through `proc_find`, which refuses a process still being made (`P_REF_NEW`) or
// already exiting (`P_REF_DEAD`). The group listing (`PROC_PGRP_ONLY`) also lists exited members
// not yet reaped, which that lookup leaves out.
#[cfg(target_os = "macos")]
fn list_live_group_members(id: u32) -> io::Result<Vec<u32>> {
    let mut members = Vec::new();
    for member in list_group_process_ids(id)? {
        if pin_running_process(member)?.is_some() {
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
        let group = Pid::from_raw(system_process_id(group_id).expect("a group's id").get());
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

    use crate::posix::process::stop::wait_for_event;

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

            // The kill's answer is checked only once the read has ended what it left.
            let kill = signal_group(child.id(), Signal::SIGKILL);
            let rest = read_group_output_to_end(&mut output, child.id(), Duration::from_secs(2));
            child.wait().expect("the leader is reaped");

            assert!(kill.expect("the group's kill is sent"));
            if rest.is_none() {
                survived_trials.push(trial);
            }
        }
        assert_eq!(survived_trials, Vec::<u64>::new());
    }
}
