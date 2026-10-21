//! A process pinned on macOS by its unique id, which the system never gives another process: the
//! id-checked reads every pinned read goes through, a pinned process's record, its re-pin from a
//! record and its stop. Every read of a pinned process asks the system to answer only while the id
//! still names that process, and every signal it is sent names the process by its id version, so a
//! reused process id is never read or signaled.

use std::ffi::CStr;
use std::io::{self, ErrorKind};
use std::sync::OnceLock;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use nix::unistd::{Pid, getsid};
use polling::os::kqueue::{PollerKqueueExt, Process, ProcessOps};
use polling::{PollMode, Poller};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

use crate::child_command::ChildEnd;
use crate::macos::processes::{
    list_child_process_ids, list_group_process_ids, read_process_environment,
};
use crate::pinned_process::ProcessRecord;
use crate::posix::process::group::signal_group;
use crate::posix::process::id::system_process_id;
use crate::posix::process::stop::{stop_pinned_process, wait_for_event};

// The key a stop registers the process's exit filter under, the only source its poller watches.
const EXIT_KEY: usize = 0;

// The record of a process's unique ids, which the SDK's headers leave out; its layout is fixed.
const UNIQUE_IDENTIFIERS_FLAVOR: libc::c_int = 17;

// The process-information call a checked read makes.
const PROCESS_INFORMATION_CALL: i32 = 2;

/// A checked read's flag: it answers only while the id names the process with this id version,
/// which `exec` changes.
pub(crate) const COMPARE_ID_VERSION: u32 = 0x1;
/// A checked read's flag: it answers only while the id names the process with this unique id,
/// fixed for the process's life.
pub(crate) const COMPARE_UNIQUE_ID: u32 = 0x2;
/// A checked read's flags for a read of whatever process the id names now.
pub(crate) const COMPARE_NOTHING: u32 = 0;

/// The audit token's slot holding the process's id.
pub(crate) const TOKEN_PROCESS_ID: usize = 5;
/// The audit token's slot holding the process's id version.
pub(crate) const TOKEN_ID_VERSION: usize = 7;

// The name of the system's id for this boot, a UUID made anew at each start of the machine.
const BOOT_SESSION_NAME: &CStr = c"kern.bootsessionuuid";

unsafe extern "C" {
    // `int proc_signal_with_audittoken(audit_token_t *audittoken, int sig)`, declared in the SDK's
    // `libproc.h`: sends `sig` to the process the token names only while its id version still
    // names it, answering 0 or the `errno` of the failure.
    fn proc_signal_with_audittoken(token: *mut AuditToken, signal: libc::c_int) -> libc::c_int;
}

/// An audit token: who last used a socket's other end, or which process a signal is for.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub(crate) struct AuditToken {
    /// The token's words, as the system lays them out.
    pub(crate) val: [u32; 8],
}

impl AuditToken {
    /// The token's bytes, as the system lays them out.
    pub(crate) fn to_bytes(self) -> [u8; size_of::<Self>()] {
        let mut bytes = [0; size_of::<Self>()];
        for (chunk, word) in bytes
            .as_chunks_mut::<{ size_of::<u32>() }>()
            .0
            .iter_mut()
            .zip(self.val)
        {
            *chunk = word.to_ne_bytes();
        }
        bytes
    }
}

/// A process's unique ids, the system's `proc_uniqidentifierinfo`.
#[repr(C)]
pub(crate) struct UniqueIdentifiers {
    uuid: [u8; 16],
    /// The process's unique id, fixed for its life and never given another process.
    pub(crate) unique_id: u64,
    parent_unique_id: u64,
    /// The process's id version, which each fork and `exec` makes anew.
    pub(crate) id_version: i32,
    original_parent_id_version: i32,
    reserved: [u64; 2],
}

const _: () = assert!(size_of::<UniqueIdentifiers>() == 56);

/// `__proc_info_extended_id(callnum, pid, flavor, flags, ext_id, arg, buffer, buffersize)`: a
/// process-information read that the kernel answers only while `pid` names the process `flags`
/// and `ext_id` pin, failing with `ESRCH` otherwise.
type CheckedProcessRead =
    unsafe extern "C" fn(i32, i32, u32, u32, u64, u64, u64, i32) -> libc::c_int;

/// A private `libsystem_kernel` call no SDK header declares; used because it is the one process
/// read the kernel refuses atomically when the id names any process but the pinned one, where a
/// public `sysctl` start-time read is a read-then-compare race. Looked up once at run time, so a
/// macOS without it refuses callers instead of failing to load the daemon; `None` there.
fn checked_process_read() -> Option<CheckedProcessRead> {
    static READ: OnceLock<Option<CheckedProcessRead>> = OnceLock::new();
    *READ.get_or_init(|| {
        // SAFETY: `RTLD_DEFAULT` searches every loaded image, and the name is a C string.
        let symbol =
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"__proc_info_extended_id".as_ptr()) };
        (!symbol.is_null()).then(|| {
            // SAFETY: the symbol is libsystem_kernel's function of exactly this signature.
            unsafe { std::mem::transmute::<*mut libc::c_void, CheckedProcessRead>(symbol) }
        })
    })
}

/// A process held by its unique id, so a read made through it names that process or finds it
/// ended, never another process given its id.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    /// The process's id.
    pub(crate) id: u32,
    /// The process's unique id.
    pub(crate) unique_id: u64,
    /// The connection's audit token for a peer, which also names the program the process runs at
    /// the connect; `None` for a process pinned by its id alone.
    pub(crate) audit_token: Option<AuditToken>,
}

impl PinnedProcess {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The audit token a peer was read from; `None` for a process pinned by its id alone.
    pub(crate) fn audit_token(&self) -> Option<AuditToken> {
        self.audit_token
    }

    /// The record a later process re-pins this one from: its id, unique id, start time and the
    /// boot's UUID; `None` once it has ended. Fails with the system's error, and with
    /// `Unsupported` on a macOS without the checked read.
    pub fn record(&self) -> io::Result<Option<ProcessRecord>> {
        let Some(started_at) = read_start_time(self.id, self.unique_id)? else {
            return Ok(None);
        };
        Ok(Some(ProcessRecord {
            id: self.id,
            start: self.unique_id,
            started_at: Some(started_at),
            boot: current_boot()?,
            job: None,
        }))
    }

    /// Stops the process: `SIGTERM`, then once `grace` passes without its exit `SIGKILL` to it,
    /// its whole process group and every descendant listed before the kill, each signal naming its
    /// process by the id version read with it, and the rest of the group is killed on the
    /// process's own exit too, unless its id has passed to another process, which happens only
    /// once the group has ended. Blocking, so it runs in `spawn_blocking`; answers the end that
    /// took effect, [`ChildEnd::Stop`] for a process already gone, and fails with `TimedOut` when
    /// it outlives the kill's bound, else with the system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        // Watched before the first signal, so the exit that signal causes is never missed.
        let exit_watch = ExitWatch::attach(self.id)?;
        stop_pinned_process(
            grace,
            |signal| self.send_signal(signal),
            |bound| exit_watch.wait(bound),
        )
    }

    /// Stops the process and the group it leads: `SIGTERM` to it and to the rest of its group,
    /// unless its id has passed to another process, then as [`Self::stop`] once `grace` passes.
    /// Blocking, so it runs in `spawn_blocking`; answers and fails as [`Self::stop`] does.
    pub fn stop_group(&self, grace: Duration) -> io::Result<ChildEnd> {
        let exit_watch = ExitWatch::attach(self.id)?;
        stop_pinned_process(
            grace,
            |signal| {
                if signal == Signal::SIGKILL {
                    return self.send_signal(signal);
                }
                let is_running = self.send_checked_signal(signal);
                let group_end = self.signal_rest_of_own_group(signal);
                let is_running = is_running?;
                group_end?;
                Ok(is_running)
            },
            |bound| exit_watch.wait(bound),
        )
    }

    /// Asks the process to end by itself: `SIGHUP`, naming it by its id version, so no process
    /// given its id meanwhile is signaled; `false` when it has ended. Fails with the system's
    /// error, and with `Unsupported` on a macOS without the checked read.
    pub fn hang_up(&self) -> io::Result<bool> {
        self.send_checked_signal(Signal::SIGHUP)
    }

    /// Waits with no bound and no thread for the process's end, an end before the wait included:
    /// the runtime watches the descriptor of a `kqueue` holding the process's exit filter, which
    /// reads ready once the filter posts. Dropping the wait calls it off. Must be called within the
    /// runtime. Fails with the system's error.
    pub async fn wait_for_end(&self) -> io::Result<()> {
        let Some(poller) = ExitWatch::attach(self.id)?.poller else {
            return Ok(());
        };
        // Attached by id alone, so a process given the id after this one ended is checked off
        // once the filter is on: the end came before the wait.
        if !is_running(self)? {
            return Ok(());
        }
        // SAFETY: the poller's descriptor stays open for as long as the `AsyncFd` owns the poller,
        // and `as_raw_fd` answers that one descriptor every time.
        let exit = unsafe { AsyncFd::register_with_interest(poller, Interest::READABLE) }?;
        loop {
            let mut ready = exit.readable().await?;
            // The ready read takes the posted exit off the queue; a wake with none waits again.
            if wait_for_event(exit.get_ref(), Duration::ZERO)? {
                return Ok(());
            }
            ready.clear_ready();
        }
    }

    // Sends `signal` to the process; `false` when it has ended. A `SIGKILL` first lists every
    // descendant, since a command a lasting child starts in a session of its own leaves its group,
    // then kills the process, the rest of its group and each descendant, in that order; the group
    // and the descendants whatever the process answers, since either can outlive it, the group
    // unless the process's id has passed to another process. Fails with the first error a signal
    // met, once every signal is sent.
    fn send_signal(&self, signal: Signal) -> io::Result<bool> {
        if signal != Signal::SIGKILL {
            return self.send_checked_signal(signal);
        }
        let descendants = list_descendants(self);
        let is_running = self.send_checked_signal(signal);
        let group_end = self.signal_rest_of_own_group(signal);
        // Every descendant is signaled, and the first refusal is kept.
        let mut descendant_end = Ok(());
        for descendant in &descendants {
            let end = descendant.send_checked_signal(signal).map(drop);
            descendant_end = descendant_end.and(end);
        }
        let is_running = is_running?;
        group_end?;
        descendant_end?;
        Ok(is_running)
    }

    // Sends `signal` to the rest of the group the process leads by its id, unless another process
    // holds that id, which it takes only once the group has ended; `false` when nothing was
    // signaled.
    fn signal_rest_of_own_group(&self, signal: Signal) -> io::Result<bool> {
        if pin_running_process(self.id)?.is_some_and(|holder| holder.unique_id != self.unique_id) {
            return Ok(false);
        }
        signal_group(self.id, signal)
    }

    // Sends `signal` to the process the id still names, by the id version read in the same check
    // that finds it running; `false` when it has ended.
    fn send_checked_signal(&self, signal: Signal) -> io::Result<bool> {
        let Some(identifiers) =
            read_unique_identifiers(self.id, COMPARE_UNIQUE_ID, self.unique_id)?
        else {
            return Ok(false);
        };
        let mut token = AuditToken { val: [0; 8] };
        token.val[TOKEN_PROCESS_ID] = self.id;
        token.val[TOKEN_ID_VERSION] = identifiers.id_version.cast_unsigned();
        // SAFETY: `proc_signal_with_audittoken`, declared in the SDK's `libproc.h`, takes `token`,
        // a live `audit_token_t` it only reads, and a valid signal number.
        let status = unsafe { proc_signal_with_audittoken(&raw mut token, signal as libc::c_int) };
        match status {
            0 => Ok(true),
            libc::ESRCH => Ok(false),
            errno => Err(io::Error::from_raw_os_error(errno)),
        }
    }
}

// Every running descendant of `process` the system lets this user read, each pinned by its unique
// id, children before their own; a process whose children or identity cannot be read is skipped,
// so the kill still reaches every descendant it can.
fn list_descendants(process: &PinnedProcess) -> Vec<PinnedProcess> {
    let mut descendants = Vec::new();
    let mut next = 0;
    let mut parent = process.clone();
    loop {
        let child_ids = list_child_process_ids(parent.id).unwrap_or_else(|error| {
            skip_unreadable_process(parent.id, &error);
            Vec::new()
        });
        for child_id in child_ids {
            // A child read once its parent's id passed to another process is no descendant.
            match pin_running_process(child_id).and_then(|child| Ok((child, is_running(&parent)?)))
            {
                Ok((Some(child), true)) => descendants.push(child),
                Ok(_) => {}
                Err(error) => skip_unreadable_process(child_id, &error),
            }
        }
        let Some(descendant) = descendants.get(next) else {
            return descendants;
        };
        parent = descendant.clone();
        next += 1;
    }
}

// Notes a process the descendant list skips because the system would not read it.
fn skip_unreadable_process(id: u32, error: &io::Error) {
    tracing::warn!(
        error = error as &(dyn std::error::Error + 'static),
        process_id = id,
        "a process the stop lists could not be read, so it is not killed"
    );
}

/// The process `record` names, pinned: the same boot, then the same unique id and start time;
/// `None` when the machine has started again, the process has ended or its id names another
/// process. Fails with the system's error, and with `Unsupported` on a macOS without the checked
/// read.
pub(crate) fn pin_recorded(record: &ProcessRecord) -> io::Result<Option<PinnedProcess>> {
    if record.boot != current_boot()? {
        return Ok(None);
    }
    let Some(started_at) = read_start_time(record.id, record.start)? else {
        return Ok(None);
    };
    Ok(
        (record.started_at == Some(started_at)).then_some(PinnedProcess {
            id: record.id,
            unique_id: record.start,
            audit_token: None,
        }),
    )
}

/// Ends what is left of the group the process `record` names led, once that process has ended: on
/// the boot it was recorded in and while no process holds its id, each member of the group that is
/// in its session, started after it, its unique id above the recorded one, and carries
/// `environment_entry`, killed by its id version; `false` when nothing was ended. A member that
/// cannot be read or killed is logged and left. Fails with the system's error when the boot or the
/// group cannot be read, and with `Unsupported` on a macOS without the checked read.
pub(crate) fn end_recorded_survivors(
    record: &ProcessRecord,
    environment_entry: &str,
) -> io::Result<bool> {
    if record.boot != current_boot()? {
        return Ok(false);
    }
    // A process holding the id is the recorded one, or a later one, which took the id only once
    // the group's last member had ended.
    if pin_running_process(record.id)?.is_some() {
        return Ok(false);
    }
    let mut is_any_ended = false;
    for member_id in list_group_process_ids(record.id)? {
        match end_survivor(record, member_id, environment_entry) {
            Ok(is_ended) => is_any_ended |= is_ended,
            Err(error) => tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                process_id = member_id,
                "a process left in an ended child's group could not be read or killed"
            ),
        }
    }
    Ok(is_any_ended)
}

// Kills group member `member_id` when it is a survivor of `record`'s group carrying
// `environment_entry`: pinned first, its session and environment read between reads of its unique
// id, so both are the pinned process's own; `false` when it is no such survivor.
fn end_survivor(
    record: &ProcessRecord,
    member_id: u32,
    environment_entry: &str,
) -> io::Result<bool> {
    // A member that ends between the list and its reads is no survivor.
    let Some(member) = pin_running_process(member_id)? else {
        return Ok(false);
    };
    if member.unique_id <= record.start {
        return Ok(false);
    }
    let raw_member = system_process_id(member_id)?.get();
    let session = match getsid(Some(Pid::from_raw(raw_member))) {
        Ok(session) => session,
        Err(Errno::ESRCH) => return Ok(false),
        Err(errno) => return Err(io::Error::from(errno)),
    };
    let carries_entry = read_process_environment(member_id)?
        .is_some_and(|environment| environment.iter().any(|entry| entry == environment_entry));
    if !is_running(&member)?
        || u32::try_from(session.as_raw()).ok() != Some(record.id)
        || !carries_entry
    {
        return Ok(false);
    }
    member.send_checked_signal(Signal::SIGKILL)
}

// The start time of process `id` in microseconds since the epoch, read only while `unique_id`
// still names it; `None` otherwise.
fn read_start_time(id: u32, unique_id: u64) -> io::Result<Option<u64>> {
    // SAFETY: `proc_bsdinfo` is a C struct of integers and byte arrays, for which all zero bytes
    // are valid.
    let mut record: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let is_read = read_checked(
        id,
        libc::PROC_PIDTBSDINFO,
        COMPARE_UNIQUE_ID,
        unique_id,
        &mut record,
    )?;
    Ok(is_read.then(|| {
        record
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(record.pbi_start_tvusec)
    }))
}

/// The machine's current boot, the system's boot session UUID. Fails with the system's error, and
/// with `InvalidData` for a UUID that is not text.
fn current_boot() -> io::Result<String> {
    let mut text = [0_u8; 64];
    let mut length = text.len();
    // SAFETY: the name is a C string, and `text` is a live, writable buffer of `length` bytes,
    // which the call fills and whose filled length it writes back.
    let status = unsafe {
        libc::sysctlbyname(
            BOOT_SESSION_NAME.as_ptr(),
            text.as_mut_ptr().cast(),
            &raw mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    CStr::from_bytes_until_nul(&text[..length.min(text.len())])
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?
        .to_str()
        .map(str::to_owned)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

/// The caller's own child `id`, pinned; the child is not yet reaped, so no other process can take
/// its id meanwhile. Fails with `ESRCH` when the system has no record of it, else with the
/// system's error.
pub fn pin_child_process(id: u32) -> io::Result<PinnedProcess> {
    pin_running_process(id)?.ok_or_else(|| io::Error::from(Errno::ESRCH))
}

/// A `kqueue` exit filter on one process, or nothing to watch when the process was already
/// exiting as the filter was attached.
struct ExitWatch {
    poller: Option<Poller>,
}

impl ExitWatch {
    /// Attaches the exit filter to process `id`. Fails with `InvalidInput` for an id of 0 or past
    /// `i32::MAX`, else with the system's error.
    fn attach(id: u32) -> io::Result<Self> {
        let raw_pid = system_process_id(id)?;
        let poller = Poller::new()?;
        // SAFETY: the kernel's exit filter watches any process this user runs, not only a child;
        // a process given the id after the pinned one ended is never signaled, since each signal
        // names the pinned process by its id version, so the stop ends at once.
        let process = unsafe { Process::from_pid(raw_pid, ProcessOps::Exit) };
        match poller.add_filter(process, EXIT_KEY, PollMode::Oneshot) {
            Ok(()) => Ok(Self {
                poller: Some(poller),
            }),
            // The kernel refuses the filter for a process already exiting.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(Self { poller: None }),
            Err(error) => Err(error),
        }
    }

    /// Waits up to `bound` for the process's exit; answers whether it came. The one-shot filter
    /// posts once, so a wait follows only waits that answered `false`.
    fn wait(&self, bound: Duration) -> io::Result<bool> {
        let Some(poller) = &self.poller else {
            return Ok(true);
        };
        wait_for_event(poller, bound)
    }
}

/// Whether `process` still runs under its id. Fails with the system's error.
pub(crate) fn is_running(process: &PinnedProcess) -> io::Result<bool> {
    Ok(read_unique_identifiers(process.id, COMPARE_UNIQUE_ID, process.unique_id)?.is_some())
}

/// This process, pinned.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    pin_running_process(std::process::id())
        .expect("this process reads its own record")
        .expect("this process runs")
}

/// Process `id`, pinned as it runs now; `None` for an id of 0 or past `i32::MAX`, or when no
/// process has the id.
pub fn pin_running_process(id: u32) -> io::Result<Option<PinnedProcess>> {
    Ok(
        read_unique_identifiers(id, COMPARE_NOTHING, 0)?.map(|identifiers| PinnedProcess {
            id,
            unique_id: identifiers.unique_id,
            audit_token: None,
        }),
    )
}

/// Process `id`'s unique ids, while `flags` and `pin` still name it; `None` otherwise.
pub(crate) fn read_unique_identifiers(
    id: u32,
    flags: u32,
    pin: u64,
) -> io::Result<Option<UniqueIdentifiers>> {
    // SAFETY: `UniqueIdentifiers` is a C struct of integers, for which all zero bytes are valid.
    let mut identifiers: UniqueIdentifiers = unsafe { std::mem::zeroed() };
    let is_read = read_checked(id, UNIQUE_IDENTIFIERS_FLAVOR, flags, pin, &mut identifiers)?;
    Ok(is_read.then_some(identifiers))
}

/// Fills `record` with process `id`'s `flavor` record, answering `false` when `id` names no
/// process `flags` and `pin` accept. `Record` must be the C struct of integers `flavor` writes.
/// Fails with the system's error, with `Other` when the record comes back short, and with
/// `Unsupported` on a macOS without the checked read.
pub(crate) fn read_checked<Record>(
    id: u32,
    flavor: libc::c_int,
    flags: u32,
    pin: u64,
    record: &mut Record,
) -> io::Result<bool> {
    let Some(read) = checked_process_read() else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "this macOS has no id-checked process read",
        ));
    };
    // An id of 0 or past `i32::MAX` names no process the daemon reads.
    let Ok(pid) = system_process_id(id) else {
        return Ok(false);
    };
    let record_length =
        i32::try_from(size_of::<Record>()).expect("a process record's size fits in an i32");
    let flavor = u32::try_from(flavor).expect("a flavor is positive");
    // SAFETY: `record` is a live, writable `Record` of the length given, the struct `flavor` asks
    // the call to fill, and nothing else reads it until the call returns.
    let written = unsafe {
        read(
            PROCESS_INFORMATION_CALL,
            pid.get(),
            flavor,
            flags,
            pin,
            0,
            (&raw mut *record).addr() as u64,
            record_length,
        )
    };
    if written == record_length {
        return Ok(true);
    }
    if written > 0 {
        return Err(io::Error::other(format!(
            "process {id}'s record came back {written} of {record_length} bytes"
        )));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error)
}
