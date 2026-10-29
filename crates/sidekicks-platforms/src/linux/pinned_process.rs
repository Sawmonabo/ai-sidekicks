//! A process pinned on Linux by a process descriptor, which never moves to another process: a
//! pinned process's record, its re-pin from a record and its stop. A process id can be taken by a
//! new process once its holder is reaped, so each read is checked against the descriptor and each
//! signal to the process is sent through it.

use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::sync::Arc;
use std::time::Duration;

use nix::sys::signal::Signal;
use polling::{Event, Poller};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

use crate::child_command::ChildEnd;
use crate::linux::process_start::read_process_start;
use crate::linux::{read_process_file, read_process_stat_fields};
use crate::pinned_process::ProcessRecord;
use crate::posix::process::group::signal_group;
use crate::posix::process::id::system_process_id;
use crate::posix::process::stop::{stop_pinned_process, wait_for_event};

/// The stat file's field holding the process's group.
pub(crate) const GROUP_FIELD: usize = 5;

/// The stat file's field holding the process's session.
pub(crate) const SESSION_FIELD: usize = 6;

// The stat file's field holding the process's start, in clock ticks since boot.
const START_FIELD: usize = 22;

// The key a stop registers the process's exit under, the only source its poller watches.
const EXIT_KEY: usize = 0;

// The line of a process descriptor's fdinfo file naming its process: `-1` once it is reaped, `0`
// when it lies outside this process's pid namespace.
const FDINFO_PROCESS_PREFIX: &str = "Pid:";

// The kernel's id for this boot, a UUID made anew at each start of the machine.
const BOOT_ID_FILE: &str = "/proc/sys/kernel/random/boot_id";

/// A process held by its process descriptor, so a read made through it names that process or
/// finds it ended, never another process given its id.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    /// The process's id, as this process's pid namespace numbers it.
    pub(crate) id: u32,
    /// The descriptor holding the process.
    pub(crate) descriptor: Arc<OwnedFd>,
}

impl PinnedProcess {
    /// The process's id, as this process's pid namespace numbers it.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The record a later process re-pins this one from; `None` once it has been reaped. Fails
    /// with the system's error, and with `InvalidData` for a stat file whose start does not read.
    pub fn record(&self) -> io::Result<Option<ProcessRecord>> {
        let Some([start]) = read_process_stat_fields(self.id, [START_FIELD])? else {
            return Ok(None);
        };
        // The stat file names this process only if its descriptor still names a live one after it.
        if descriptor_process_id(self.descriptor.as_raw_fd())?.is_none() {
            return Ok(None);
        }
        Ok(Some(ProcessRecord {
            id: self.id,
            start: parse_stat_number(&start)?,
            started_at: None,
            boot: current_boot()?,
            job: None,
        }))
    }

    /// Stops the process: `SIGTERM` through its descriptor, so no process given its id meanwhile is
    /// signaled, then once `grace` passes without its exit `SIGKILL` to it and its whole process
    /// group, and the rest of the group is killed on the process's own exit too, unless its id has
    /// passed to another process, which happens only once the group has ended. Blocking, so it
    /// runs in `spawn_blocking`; answers the end that took effect, [`ChildEnd::Stop`] for a process
    /// already gone, and fails with `TimedOut` when it outlives the kill's bound, else with the
    /// system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        stop_pinned_process(
            grace,
            |signal| self.send_signal(signal),
            |bound| self.wait_for_exit(bound),
        )
    }

    /// Stops the process and the group it leads: `SIGTERM` to it and to its whole group, then as
    /// [`Self::stop`] once `grace` passes. Blocking, so it runs in `spawn_blocking`; answers and
    /// fails as [`Self::stop`] does.
    pub fn stop_group(&self, grace: Duration) -> io::Result<ChildEnd> {
        stop_pinned_process(
            grace,
            |signal| self.send_to_group(signal),
            |bound| self.wait_for_exit(bound),
        )
    }

    /// Ends the daemon's process: `SIGTERM` through its descriptor, then once `grace` passes
    /// without its exit `SIGKILL` the same way, to the process alone; each child it started ends
    /// by its parent-death signal, which a lasting child does not arm, so every lasting session
    /// outlives it. Blocking, so it runs in `spawn_blocking`; answers and fails as [`Self::stop`]
    /// does.
    pub fn stop_sparing_lasting_sessions(&self, grace: Duration) -> io::Result<ChildEnd> {
        stop_pinned_process(
            grace,
            |signal| self.send_through_descriptor(signal, 0),
            |bound| self.wait_for_exit(bound),
        )
    }

    /// Asks the process to end by itself: `SIGHUP` through its descriptor, so no process given its
    /// id meanwhile is signaled; `false` when it has ended. Fails with the system's error.
    pub fn hang_up(&self) -> io::Result<bool> {
        self.send_through_descriptor(Signal::SIGHUP, 0)
    }

    /// Kills the process alone with `SIGKILL` through its descriptor, so no process given its id
    /// meanwhile is signaled; `false` when it has ended. Fails with the system's error.
    pub fn kill(&self) -> io::Result<bool> {
        self.send_through_descriptor(Signal::SIGKILL, 0)
    }

    /// Waits with no bound and no thread for the process's end, an end before the wait included:
    /// the runtime watches a copy of its descriptor, which reads ready once it has exited. Dropping
    /// the wait calls it off. Must be called within the runtime. Fails with the system's error.
    pub async fn wait_for_end(&self) -> io::Result<()> {
        let descriptor = self.descriptor.try_clone()?;
        // SAFETY: the copy is the descriptor the `AsyncFd` owns from here, open until the `AsyncFd`
        // drops it, and `as_raw_fd` answers that one descriptor every time.
        let exit = unsafe { AsyncFd::register_with_interest(descriptor, Interest::READABLE) }?;
        let _ended = exit.readable().await?;
        Ok(())
    }

    // Sends `signal` through the descriptor, `SIGKILL` to the process and then to the whole group
    // it leads, so nothing a lasting child started outlives it; `false` when the process has
    // ended.
    fn send_signal(&self, signal: Signal) -> io::Result<bool> {
        if signal != Signal::SIGKILL {
            return self.send_through_descriptor(signal, 0);
        }
        self.send_to_group(signal)
    }

    // Sends `signal` to the process and then to the whole group it leads; `false` when the process
    // has ended. From Linux 6.9 the descriptor's group signal reaches exactly the group; a kernel
    // before 6.9 refuses the group flag with `EINVAL`, so the rest of the group is signaled by its
    // id, unless the process has been reaped and its id passed to another process, which happens
    // only once the group has ended. Fails with the first error a signal met, once both are sent.
    fn send_to_group(&self, signal: Signal) -> io::Result<bool> {
        let is_running = self.send_through_descriptor(signal, 0);
        let group_end = match self.send_through_descriptor(signal, libc::PIDFD_SIGNAL_PROCESS_GROUP)
        {
            Err(error) if error.raw_os_error() == Some(libc::EINVAL) => {
                self.signal_rest_of_own_group(signal).map(|_| ())
            }
            sent => sent.map(|_| ()),
        };
        let is_running = is_running?;
        group_end?;
        Ok(is_running)
    }

    // Sends `signal` to the rest of the group the process leads by its id, unless the process has
    // been reaped and another process holds its id; `false` when nothing was signaled.
    fn signal_rest_of_own_group(&self, signal: Signal) -> io::Result<bool> {
        let is_reaped = descriptor_process_id(self.descriptor.as_raw_fd())?.is_none();
        if is_reaped && is_id_held(self.id)? {
            return Ok(false);
        }
        signal_group(self.id, signal)
    }

    /// Sends `signal` through the descriptor with `flags`; `false` when the process has ended.
    /// Fails with the system's error.
    pub(crate) fn send_through_descriptor(
        &self,
        signal: Signal,
        flags: libc::c_uint,
    ) -> io::Result<bool> {
        // SAFETY: the descriptor stays open while `self` lives, and the call takes it, a signal
        // number, no signal information and the flags.
        let status = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.descriptor.as_raw_fd(),
                signal as libc::c_int,
                std::ptr::null::<libc::siginfo_t>(),
                flags,
            )
        };
        if status == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        Err(error)
    }

    /// Waits up to `bound` for the descriptor to read ready, which it does once the process has
    /// exited, an exit before the wait included; answers whether it did. Fails with the system's
    /// error.
    pub(crate) fn wait_for_exit(&self, bound: Duration) -> io::Result<bool> {
        let poller = Poller::new()?;
        // SAFETY: the descriptor is held by `self`, which outlives the poller made in this call.
        unsafe { poller.add(&*self.descriptor, Event::readable(EXIT_KEY)) }?;
        wait_for_event(&poller, bound)
    }
}

/// The process `record` names, pinned: its descriptor opened first, then its start and boot read
/// after the open; `None` for an id of 0 or past `i32::MAX`, which names no process, or when the
/// machine has started again, the process has ended or its id now names another process or a
/// thread. Fails with the system's error.
pub(crate) fn pin_recorded(record: &ProcessRecord) -> io::Result<Option<PinnedProcess>> {
    let id = record.id;
    if system_process_id(id).is_err() {
        return Ok(None);
    }
    let descriptor = match open_process_descriptor(id) {
        Ok(descriptor) => descriptor,
        Err(error) if names_no_process(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let process = PinnedProcess {
        id,
        descriptor: Arc::new(descriptor),
    };
    // A start read after the open that matches the record names the recorded process, which then
    // also held the id at the open, since no later process of this boot carries its start.
    Ok(process
        .record()?
        .filter(|read| read == record)
        .map(|_| process))
}

/// Ends what is left of the group the process `record` names led, once that process has ended: on
/// the boot it was recorded in and while no process holds its id, each member of the group that is
/// in its session, started no earlier than it and carries `environment_entry`, killed through its
/// own descriptor; `false` when nothing was ended. A member that cannot be read or killed is
/// logged and left. Fails with the system's error when the boot or `/proc` cannot be read.
pub(crate) fn end_recorded_survivors(
    record: &ProcessRecord,
    environment_entry: &str,
) -> io::Result<bool> {
    if record.boot != current_boot()? {
        return Ok(false);
    }
    // A process holding the id is the recorded one, or a later one, which took the id only once
    // the group's last member had ended.
    if is_id_held(record.id)? {
        return Ok(false);
    }
    let mut is_any_ended = false;
    for entry in std::fs::read_dir("/proc")? {
        let Ok(id) = entry?.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        match end_survivor(record, id, environment_entry) {
            Ok(is_ended) => is_any_ended |= is_ended,
            Err(error) => tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                process_id = id,
                "a process left in an ended child's group could not be read or killed"
            ),
        }
    }
    Ok(is_any_ended)
}

// Kills process `id` when it is a survivor of `record`'s group carrying `environment_entry`:
// pinned first, its environment read, then checked again through its pin, so the environment read
// is the pinned process's own; `false` when it is no such survivor.
fn end_survivor(record: &ProcessRecord, id: u32, environment_entry: &str) -> io::Result<bool> {
    // A process whose stat file `/proc` hides is another user's, read as no member.
    let fields = match read_process_stat_fields(id, [GROUP_FIELD, SESSION_FIELD, START_FIELD]) {
        Err(error) if error.kind() == ErrorKind::PermissionDenied => return Ok(false),
        read => read?,
    };
    let Some([group, session, start]) = fields else {
        return Ok(false);
    };
    let recorded_id = i64::from(record.id);
    let start = parse_stat_number::<u64>(&start)?;
    if parse_stat_number::<i64>(&group)? != recorded_id
        || parse_stat_number::<i64>(&session)? != recorded_id
        || start < record.start
    {
        return Ok(false);
    }
    let Some(member) = pin_running_process(id)? else {
        return Ok(false);
    };
    let is_pinned_member = |member: &PinnedProcess| -> io::Result<bool> {
        Ok(member.record()?.is_some_and(|read| read.start == start))
    };
    if !is_pinned_member(&member)? {
        return Ok(false);
    }
    let carries_entry = read_process_start(id)?.is_some_and(|start| {
        start
            .environment
            .iter()
            .any(|entry| entry == environment_entry)
    });
    if !carries_entry || !is_pinned_member(&member)? {
        return Ok(false);
    }
    member.send_through_descriptor(Signal::SIGKILL, 0)
}

// Whether a process holds `id`, one whose stat file `/proc` hides included.
fn is_id_held(id: u32) -> io::Result<bool> {
    match read_process_file(id, "stat") {
        Ok(stat) => Ok(stat.is_some()),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => Ok(true),
        Err(error) => Err(error),
    }
}

// A stat file's number field read as `Number`; fails with `InvalidData` when it is not one.
fn parse_stat_number<Number: std::str::FromStr<Err = std::num::ParseIntError>>(
    field: &str,
) -> io::Result<Number> {
    field
        .parse()
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

// The machine's current boot, the kernel's boot id.
fn current_boot() -> io::Result<String> {
    Ok(std::fs::read_to_string(BOOT_ID_FILE)?.trim().to_owned())
}

/// Process `id` as it runs now, pinned by a descriptor; `None` for an id of 0 or past `i32::MAX`,
/// or when no process has the id, a thread's id included. Fails with the system's error.
pub fn pin_running_process(id: u32) -> io::Result<Option<PinnedProcess>> {
    if system_process_id(id).is_err() {
        return Ok(None);
    }
    match open_process_descriptor(id) {
        Ok(descriptor) => Ok(Some(PinnedProcess {
            id,
            descriptor: Arc::new(descriptor),
        })),
        Err(error) if names_no_process(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

// Whether a descriptor's open failed because the id names no running process: `ESRCH` for an id
// no task holds, and for an id that names a thread other than its process's first, `EINVAL` before
// Linux 6.9 and `ENOENT` from it.
fn names_no_process(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ESRCH | libc::EINVAL | libc::ENOENT)
    )
}

/// The caller's own child `id`, pinned; the child is not yet reaped, so no other process can take
/// its id meanwhile. Fails with `ESRCH` when no process has the id, with `InvalidInput` for an id
/// of 0 or past `i32::MAX`, else with the system's error.
pub fn pin_child_process(id: u32) -> io::Result<PinnedProcess> {
    Ok(PinnedProcess {
        id,
        descriptor: Arc::new(open_process_descriptor(id)?),
    })
}

/// This process, pinned.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    let id = std::process::id();
    PinnedProcess {
        id,
        descriptor: Arc::new(
            open_process_descriptor(id).expect("this process opens its own descriptor"),
        ),
    }
}

/// The id of the process `descriptor` holds, from its fdinfo file; `None` once it is reaped. Fails
/// with `Other` for a process outside this pid namespace, and `InvalidData` for a file with no id.
pub(crate) fn descriptor_process_id(descriptor: RawFd) -> io::Result<Option<u32>> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{descriptor}"))?;
    let invalid = || {
        io::Error::new(
            ErrorKind::InvalidData,
            "a process descriptor's fdinfo names no process",
        )
    };
    let id: i64 = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix(FDINFO_PROCESS_PREFIX))
        .ok_or_else(invalid)?
        .trim()
        .parse()
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    match id {
        -1 => Ok(None),
        0 => Err(io::Error::other(
            "the process lies outside this pid namespace",
        )),
        id => u32::try_from(id)
            .map(Some)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error)),
    }
}

/// A new descriptor holding process `id`. Fails with `ESRCH` when no process has the id, and with
/// `InvalidInput` for an id of 0 or past `i32::MAX`, which no process has.
pub(crate) fn open_process_descriptor(id: u32) -> io::Result<OwnedFd> {
    let pid = system_process_id(id)?.get();
    // SAFETY: `pidfd_open` takes a pid and no flags and returns a new descriptor or -1.
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let descriptor = RawFd::try_from(descriptor).map_err(io::Error::other)?;
    // SAFETY: the call succeeded, so `descriptor` is a new open descriptor nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::{current_boot, pin_recorded, pin_running_process};
    use crate::pinned_process::ProcessRecord;

    // Fails when a descriptor's open refused for a thread's id reads as a failure, which fails the
    // orphan sweep, and with it every start, while a thread holds a recorded shell's old id.
    #[test]
    fn a_thread_s_id_pins_no_process() {
        let (id_sender, id_receiver) = mpsc::channel();
        let (end_sender, end_receiver) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            id_sender
                .send(nix::unistd::gettid().as_raw())
                .expect("the test reads the thread's id");
            end_receiver.recv().expect("the test ends the thread");
        });
        let thread_id = u32::try_from(id_receiver.recv().expect("the thread sends its id"))
            .expect("a thread's id is positive");
        let record = ProcessRecord {
            id: thread_id,
            start: 0,
            started_at: None,
            boot: current_boot().expect("the boot reads"),
            job: None,
        };

        let running = pin_running_process(thread_id).map(|process| process.is_some());
        let recorded = pin_recorded(&record).map(|process| process.is_some());

        end_sender.send(()).expect("the thread waits for its end");
        thread.join().expect("the thread ends");
        assert!(!running.expect("the thread's id reads"));
        assert!(!recorded.expect("the thread's record reads"));
    }
}
