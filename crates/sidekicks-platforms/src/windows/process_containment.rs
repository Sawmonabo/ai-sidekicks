//! The daemon's hold on what it starts, on Windows: a job the daemon assigns itself to at start.
//! Every process the daemon or its children start joins it, the `ConPTY` shells alacritty starts
//! with no hook among them, and the job ends every one of them when its last handle closes, which
//! the daemon's own end closes, a crash included. A child that asks to leave it may, which a
//! lasting child does; so that nothing a shell runs can leave with it, each shell's `shell` mode
//! also runs in a job of its own, nested in the daemon's, which allows no leaving and ends the
//! shell's whole tree once the shell's hold drops. Where an outer job the daemon was started in
//! refuses a nested job, the daemon runs without either, which its start logs once.

use std::io;
use std::os::windows::io::{
    AsHandle as _, AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle,
};
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, FALSE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

use crate::windows::error_codes::win32_code;

/// The daemon's job, held open for the daemon's whole life; its handle closes only with the
/// process. Unset where an outer job refused it.
static DAEMON_JOB: OnceLock<OwnedHandle> = OnceLock::new();

/// Makes a nameless job that ends every process in it once its last handle closes and lets a child
/// started with `CREATE_BREAKAWAY_FROM_JOB` leave it, and assigns the daemon's own process to it;
/// a job the daemon already runs in becomes the new one's parent, and one that refuses a nested
/// job leaves the daemon without its job, logged. Fails with `AlreadyExists` once the job is made,
/// else with the system's error.
pub(crate) fn contain_daemon_descendants() -> io::Result<()> {
    // A second job would end the daemon with it once its handle dropped.
    if DAEMON_JOB.get().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "the daemon's job was already made",
        ));
    }
    let job = create_kill_on_close_job(
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    )?;
    // SAFETY: the job is open, and the current process's pseudo handle needs no closing.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) } == FALSE {
        let error = io::Error::last_os_error();
        // An outer job with limits a nested job may not carry refuses the assignment.
        if win32_code(&error) == Some(ERROR_ACCESS_DENIED) {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "an outer job refuses the service's own, so what the service starts is not ended \
                 with it"
            );
            return Ok(());
        }
        return Err(error);
    }
    // Only the start calls this, once, so the cell is empty; a lost race would leave the job's
    // handle in the losing value, which the process then keeps by leaking it.
    if let Err(job) = DAEMON_JOB.set(job) {
        std::mem::forget(job);
    }
    Ok(())
}

/// One shell's own job, which ends the shell's whole tree as its handle closes.
pub(crate) struct ShellJob {
    /// The job's one handle.
    _job: OwnedHandle,
}

/// Puts the just-started `shell` mode `pid` in a job of its own, nested in the daemon's, that lets
/// nothing leave it and ends every process in it once its handle closes; `None` where the daemon
/// runs without its job. Fails with the system's error.
pub(crate) fn contain_shell(pid: u32) -> io::Result<Option<ShellJob>> {
    if DAEMON_JOB.get().is_none() {
        return Ok(None);
    }
    hold_in_own_job(pid).map(Some)
}

// Makes a job that ends every process in it once its handle closes, letting none leave, and
// assigns process `pid` to it.
fn hold_in_own_job(pid: u32) -> io::Result<ShellJob> {
    let job = create_kill_on_close_job(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
    // SAFETY: the call takes an access mask, a flag and an id, and answers a handle or null.
    let raw_process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid) };
    if raw_process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened and is owned by nothing else.
    let process = unsafe { OwnedHandle::from_raw_handle(raw_process) };
    // SAFETY: both handles are open, the process's with the rights an assignment needs.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(ShellJob { _job: job })
}

// Makes a nameless job with `limit_flags`, which name its kill on close.
fn create_kill_on_close_job(limit_flags: JOB_OBJECT_LIMIT) -> io::Result<OwnedHandle> {
    // SAFETY: both arguments may be null, for default security and no name; the call answers a new
    // handle or null.
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened and is owned by nothing else.
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    set_job_limits(job.as_handle(), limit_flags)?;
    Ok(job)
}

/// Sets `job`'s limits to `limit_flags` alone, every other limit cleared. Fails with the system's
/// error.
pub(crate) fn set_job_limits(
    job: BorrowedHandle<'_>,
    limit_flags: JOB_OBJECT_LIMIT,
) -> io::Result<()> {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = limit_flags;
    let length = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
        .expect("the limits' size fits a u32");
    // SAFETY: the job is open, and the call reads `length` bytes of the live limits.
    let is_set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            length,
        )
    };
    if is_set == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    use super::{contain_daemon_descendants, hold_in_own_job};
    use crate::test_program::this_test_program;

    /// The daemon's stand-in's test.
    const DAEMON_STAND_IN: &str =
        "windows::process_containment::tests::the_daemon_stand_in_starts_a_child_in_its_job";

    /// What the stand-in prints before the id of the child it started.
    const CHILD_LINE_START: &str = "started child ";

    /// How long a test waits for its child to end once the job holding it has ended.
    const CHILD_END_WAIT_MILLISECONDS: u32 = 10_000;

    #[test]
    #[ignore = "run only as the job test's child"]
    fn the_daemon_stand_in_starts_a_child_in_its_job() {
        contain_daemon_descendants().expect("the daemon's job is made");
        let second = contain_daemon_descendants().expect_err("a second job is refused");
        assert_eq!(second.kind(), std::io::ErrorKind::AlreadyExists);
        #[expect(
            clippy::zombie_processes,
            reason = "the stand-in ends with its child running, which the daemon's job then ends"
        )]
        let child = Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");
        writeln!(std::io::stdout(), "{CHILD_LINE_START}{}", child.id())
            .expect("the child's id is written");
    }

    #[test]
    fn a_child_the_daemon_started_ends_with_the_daemon() {
        let output = this_test_program(DAEMON_STAND_IN)
            .stdin(Stdio::null())
            .output()
            .expect("the stand-in runs");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{stdout}");
        let child_id: u32 = stdout
            .lines()
            .find_map(|line| line.strip_prefix(CHILD_LINE_START))
            .expect("the stand-in names its child")
            .trim()
            .parse()
            .expect("the child's id is a number");

        // SAFETY: the call takes an access mask, a flag and an id, and answers a handle or null.
        let child = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child_id) };
        if child.is_null() {
            // The child is gone already, its id no longer naming a process.
            return;
        }
        // SAFETY: the handle was just opened with the right to wait on it.
        let waited = unsafe { WaitForSingleObject(child, CHILD_END_WAIT_MILLISECONDS) };
        // SAFETY: the handle is open and owned here alone.
        unsafe { CloseHandle(child) };
        assert_eq!(waited, WAIT_OBJECT_0, "the child outlived the daemon's job");
    }

    // Fails when a shell's own job lets its tree outlive the hold, as one without its kill on
    // close does.
    #[test]
    fn a_shell_s_own_job_ends_its_process_as_the_hold_drops() {
        let mut child = Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");

        let job = hold_in_own_job(child.id()).expect("the child is held in a job of its own");
        // SAFETY: the call takes an access mask, a flag and an id, and answers a handle or null.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child.id()) };
        assert!(!handle.is_null(), "the unreaped child is opened");
        drop(job);
        // SAFETY: the handle was just opened with the right to wait on it.
        let waited = unsafe { WaitForSingleObject(handle, CHILD_END_WAIT_MILLISECONDS) };
        // SAFETY: the handle is open and owned here alone.
        unsafe { CloseHandle(handle) };
        child.wait().expect("the child is reaped");

        assert_eq!(waited, WAIT_OBJECT_0, "the shell's tree outlived its job");
    }
}
