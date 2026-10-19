//! A process pinned on Windows by an open handle, which keeps its id from passing to another
//! process while it lives: a pinned process's record, its re-pin from a record and its stop, which
//! ends the whole job a lasting child runs in, held open with it.

use std::ffi::OsStr;
use std::io::{self, ErrorKind};
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::sync::Arc;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, FALSE, FILETIME, HANDLE,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    IsProcessInJob, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
    OpenJobObjectW, QueryInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

use crate::child_command::ChildEnd;
use crate::pinned_process::{KILL_WAIT_BOUND, ProcessRecord};
use crate::windows::error_codes::win32_code;
use crate::windows::lasting_child::is_lasting_job_name;
use crate::windows::wide_text::wide_text;

/// The exit code a killed process, or every process of a killed job, is given.
pub(crate) const KILLED_EXIT_CODE: u32 = 1;

/// A process, held by its id and an open handle, which keeps its id from passing to another
/// process while the handle lives; this process is held by its id alone.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    /// The process's id.
    pub(crate) id: u32,
    /// The open handle; `None` for this process, read through its pseudo-handle.
    pub(crate) process: Option<Arc<OwnedHandle>>,
    /// The name of the job of its own a lasting child runs in; `None` for any other process.
    pub(crate) job: Option<String>,
    /// That job, held open, which keeps it and its name from passing to another job while the
    /// handle lives; `None` with the name.
    pub(crate) job_handle: Option<Arc<OwnedHandle>>,
}

impl PinnedProcess {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The record a later process re-pins this one from: its id, its creation time and its job's
    /// name; `None` once it has ended. Fails with the system's error.
    pub fn record(&self) -> io::Result<Option<ProcessRecord>> {
        if self.wait_for_exit(Duration::ZERO)? {
            return Ok(None);
        }
        Ok(Some(ProcessRecord {
            id: self.id,
            start: read_creation_time(self.handle())?,
            started_at: None,
            boot: None,
            job: self.job.clone(),
        }))
    }

    /// Ends the process, which the caller has already asked to stop by the program's own means:
    /// waits up to `grace` for its exit, then kills it. A job of its own is ended whatever the
    /// process did, its own exit included, since that exit ends nothing else in the job; blocking,
    /// so it runs in `spawn_blocking`. Answers the end that took effect; fails with `TimedOut` when
    /// it outlives the kill's bound, else with the system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        // A process that ends between the grace and the kill ended on the stop it was asked.
        if self.wait_for_exit(grace)? || self.wait_for_exit(Duration::ZERO)? {
            self.terminate_job()?;
            return Ok(ChildEnd::Stop);
        }
        if !self.terminate_job()? {
            self.terminate_process()?;
        }
        if self.wait_for_exit(KILL_WAIT_BOUND)? {
            return Ok(ChildEnd::Kill);
        }
        Err(io::Error::new(
            ErrorKind::TimedOut,
            "the process still runs after it was killed",
        ))
    }

    /// Ends every process still in the job of the process's own, through the handle held with it;
    /// `false` when it runs in none. Fails with the system's error.
    pub(crate) fn terminate_job(&self) -> io::Result<bool> {
        let Some(job) = &self.job_handle else {
            return Ok(false);
        };
        end_job_processes(job)?;
        Ok(true)
    }

    // Ends the process alone.
    fn terminate_process(&self) -> io::Result<()> {
        // SAFETY: the handle is open while `self` lives and carries the right to end the process.
        if unsafe { TerminateProcess(self.handle(), KILLED_EXIT_CODE) } == FALSE {
            let error = io::Error::last_os_error();
            // Windows refuses the end of a process already ending; the wait tells.
            if !self.wait_for_exit(Duration::ZERO)? {
                return Err(error);
            }
        }
        Ok(())
    }

    /// The handle the process is read through: its open handle, or this process's pseudo-handle.
    pub(crate) fn handle(&self) -> HANDLE {
        self.process.as_ref().map_or_else(
            // SAFETY: the call takes nothing and answers this process's pseudo-handle.
            || unsafe { GetCurrentProcess() },
            |process| process.as_raw_handle(),
        )
    }

    // Waits up to `bound` for the process's handle to signal its exit; answers whether it did.
    fn wait_for_exit(&self, bound: Duration) -> io::Result<bool> {
        // `INFINITE` is the largest count; a longer bound waits one millisecond less than it.
        let milliseconds = u32::try_from(bound.as_millis())
            .unwrap_or(u32::MAX)
            .min(INFINITE - 1);
        // SAFETY: the handle is open while `self` lives and carries the right to wait on it.
        match unsafe { WaitForSingleObject(self.handle(), milliseconds) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!("a process wait answered {other}"))),
        }
    }
}

/// The process `record` names, held open with the job it records; `None` when it has ended or its
/// id now names another process, whose creation time differs or which this user cannot open. Fails
/// with `InvalidData` when the record names a job no lasting child is given, or a job that does
/// not hold its process, else with the system's error.
pub(crate) fn pin_recorded(record: &ProcessRecord) -> io::Result<Option<PinnedProcess>> {
    // Opened before the process is read: a job holding a live process lives on, so a name that
    // opens nothing then names no job that process runs in.
    let job = record
        .job
        .as_deref()
        .map(|name| open_recorded_job(record, name))
        .transpose()?;
    let mut process = match open_process(record.id) {
        Ok(process) => process,
        // No process has the id, or it names a process of another user or a higher integrity,
        // which a lasting child this user started never is.
        Err(error)
            if matches!(
                win32_code(&error),
                Some(ERROR_INVALID_PARAMETER | ERROR_ACCESS_DENIED)
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let Some(read) = process.record()? else {
        return Ok(None);
    };
    if !(read.id == record.id && read.start == record.start) {
        return Ok(None);
    }
    let Some(name) = &record.job else {
        return Ok(Some(process));
    };
    let not_its_job = || {
        io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "process record {}'s job does not hold its process",
                record.id
            ),
        )
    };
    let job = job.flatten().ok_or_else(not_its_job)?;
    if !is_process_in_job(process.handle(), job.as_raw_handle())? {
        return Err(not_its_job());
    }
    process.job = Some(name.clone());
    process.job_handle = Some(Arc::new(job));
    Ok(Some(process))
}

/// Ends what is left of the tree `record` names once its process has ended: every process still
/// in the job a lasting child ran in; `false` when the record names no job, no job has its name
/// or the job holds no process. Fails with `InvalidData` for a job name no lasting child is given, else with the
/// system's error.
pub(crate) fn end_recorded_survivors(record: &ProcessRecord) -> io::Result<bool> {
    let Some(name) = &record.job else {
        return Ok(false);
    };
    let Some(job) = open_recorded_job(record, name)? else {
        return Ok(false);
    };
    end_job_processes(&job)
}

// The job `record` names `name`, opened with the rights to ask what it holds and to end it; `None`
// when no job has the name. Fails with `InvalidData` for a name of another shape than a lasting
// child's job is given, else with the system's error.
fn open_recorded_job(record: &ProcessRecord, name: &str) -> io::Result<Option<OwnedHandle>> {
    if !is_lasting_job_name(name) {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "process record {}'s job name is none a lasting child is given",
                record.id
            ),
        ));
    }
    let mut wide_name = wide_text(OsStr::new(name))?;
    wide_name.push(0);
    // SAFETY: the name is a live NUL-ended UTF-16 string; the call answers a new handle or null.
    let raw_job = unsafe {
        OpenJobObjectW(
            JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
            FALSE,
            wide_name.as_ptr(),
        )
    };
    if raw_job.is_null() {
        let error = io::Error::last_os_error();
        if win32_code(&error) == Some(ERROR_FILE_NOT_FOUND) {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: the handle was just opened and is owned by nothing else.
    Ok(Some(unsafe { OwnedHandle::from_raw_handle(raw_job) }))
}

// Ends every process still in `job`, which is open with the rights to ask what it holds and to
// end it; `false` when it holds none, which no end is asked for.
fn end_job_processes(job: &OwnedHandle) -> io::Result<bool> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: the job's handle is open with the right to query it, and the call writes the live
    // record of the length given and no returned length.
    let is_read = unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            (&raw mut accounting).cast(),
            u32::try_from(size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
                .expect("the accounting record's size fits a u32"),
            std::ptr::null_mut(),
        )
    };
    if is_read == FALSE {
        return Err(io::Error::last_os_error());
    }
    if accounting.ActiveProcesses == 0 {
        return Ok(false);
    }
    // SAFETY: the job's handle is open and carries the right to end it.
    if unsafe { TerminateJobObject(job.as_raw_handle(), KILLED_EXIT_CODE) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(true)
}

/// Whether `process` runs in `job`, or in any job when `job` is null; both handles carry the
/// right to query them. Fails with the system's error.
pub(crate) fn is_process_in_job(process: HANDLE, job: HANDLE) -> io::Result<bool> {
    let mut is_in_job = FALSE;
    // SAFETY: the handles are open with the right to query them, or the job's null, and the result
    // points at a live `BOOL`.
    if unsafe { IsProcessInJob(process, job, &raw mut is_in_job) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(is_in_job != FALSE)
}

/// The caller's own child `id`, held open; the caller's handle to the child keeps its id from
/// passing to another process meanwhile. Fails with the system's error, `ERROR_INVALID_PARAMETER`
/// when no process has the id.
pub fn pin_child_process(id: u32) -> io::Result<PinnedProcess> {
    open_process(id)
}

/// This process, held by its id.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    PinnedProcess {
        id: std::process::id(),
        process: None,
        job: None,
        job_handle: None,
    }
}

// Process `id`, opened with the rights to read its times, wait on it and end it.
fn open_process(id: u32) -> io::Result<PinnedProcess> {
    // SAFETY: the call takes plain values and answers a new handle or null.
    let raw_process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            FALSE,
            id,
        )
    };
    if raw_process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened and is owned by nothing else, so it closes on every path.
    let process = unsafe { OwnedHandle::from_raw_handle(raw_process) };
    Ok(PinnedProcess {
        id,
        process: Some(Arc::new(process)),
        job: None,
        job_handle: None,
    })
}

// The process's creation time, as one integer of 100-nanosecond intervals.
fn read_creation_time(process: HANDLE) -> io::Result<u64> {
    let mut times = [FILETIME::default(); 4];
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: the handle is open and carries the right to read the process's times, and each
    // pointer names a live `FILETIME` the call writes.
    if unsafe { GetProcessTimes(process, creation, exit, kernel, user) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::time::{Duration, Instant};

    use rstest::rstest;
    use sysinfo::{Pid, ProcessesToUpdate, System};

    use super::PinnedProcess;
    use crate::child_command::ChildEnd;
    use crate::lasting_child::{LastingChild, LastingCommand};
    use crate::pinned_process::KILL_WAIT_BOUND;
    use crate::windows::lasting_child::spawn_lasting_child;
    use crate::{ProcessRecord, pin_child_process};

    // Fails when the stop ends the process alone, or re-pins it without its job; or when a record
    // naming a job of another shape, one no job has, or another lasting child's job, which does
    // not hold its running process, re-pins it.
    #[test]
    fn pinned_process_stop_ends_a_re_pinned_lasting_child_and_its_child() {
        let (child, grandchild) = start_lasting_child(&[
            "/d",
            "/c",
            "start",
            "/b",
            "ping",
            "-n",
            "60",
            "127.0.0.1",
            "&",
            "ping",
            "-n",
            "60",
            "127.0.0.1",
        ]);
        let job_name = child
            .record
            .job
            .clone()
            .expect("a lasting child records its job");
        let other = spawn_shell(&["/d", "/c", "ping", "-n", "60", "127.0.0.1"]);
        let refusals = [
            format!("{job_name}0"),
            format!("ai-sidekicks-lasting-{}", "0".repeat(32)),
            other
                .record
                .job
                .clone()
                .expect("a lasting child records its job"),
        ]
        .map(|job| {
            ProcessRecord {
                job: Some(job),
                ..child.record.clone()
            }
            .pin()
            .map(|_| ())
            .map_err(|error| error.kind())
        });
        let re_pinned = child
            .record
            .pin()
            .expect("the re-pin reads")
            .expect("the child runs");

        let end = re_pinned
            .stop(Duration::ZERO)
            .expect("the stop ends the child");
        let other_end = other
            .process
            .stop(Duration::ZERO)
            .expect("the stop ends the other child");

        assert_eq!(
            refusals,
            [
                Err(ErrorKind::InvalidData),
                Err(ErrorKind::InvalidData),
                Err(ErrorKind::InvalidData)
            ]
        );
        assert_eq!(other_end, ChildEnd::Kill);
        assert_eq!(end, ChildEnd::Kill);
        assert!(
            child
                .process
                .wait_for_exit(KILL_WAIT_BOUND)
                .expect("the child's wait reads")
        );
        assert!(
            grandchild
                .wait_for_exit(KILL_WAIT_BOUND)
                .expect("the grandchild's wait reads")
        );
    }

    // Fails when a stop returns on the process's own exit without ending its job, or when a
    // record whose process has ended leaves its job running; either leaves the child it started
    // running.
    #[rstest]
    #[case::by_the_stop(true)]
    #[case::by_the_record(false)]
    fn pinned_process_job_ends_after_a_lasting_child_exits(#[case] is_by_the_stop: bool) {
        let (child, grandchild) =
            start_lasting_child(&["/d", "/c", "start", "/b", "ping", "-n", "60", "127.0.0.1"]);
        assert!(
            child
                .process
                .wait_for_exit(KILL_WAIT_BOUND)
                .expect("the child's wait reads")
        );

        let ended = if is_by_the_stop {
            child.process.stop(Duration::ZERO).expect("the stop reads") == ChildEnd::Stop
        } else {
            child.record.pin().expect("the re-pin reads").is_none()
                && child.record.end_survivors().expect("the survivors end")
        };

        assert!(ended);
        assert!(
            grandchild
                .wait_for_exit(KILL_WAIT_BOUND)
                .expect("the grandchild's wait reads")
        );
    }

    // Fails when a stop or a record ends a job that holds no process, which Windows does not
    // promise to allow, or a record answers that it ended something there.
    #[test]
    fn pinned_process_job_holding_nothing_is_not_ended() {
        let child = spawn_shell(&["/d", "/c", "exit 0"]);
        assert!(
            child
                .process
                .wait_for_exit(KILL_WAIT_BOUND)
                .expect("the child's wait reads")
        );

        let end = child.process.stop(Duration::ZERO).expect("the stop reads");
        let is_ended = child.record.end_survivors().expect("the survivors read");

        assert_eq!(end, ChildEnd::Stop);
        assert!(!is_ended);
    }

    // A lasting child of the command shell running `arguments`, and the first child it starts.
    fn start_lasting_child(arguments: &[&str]) -> (LastingChild, PinnedProcess) {
        let child = spawn_shell(arguments);
        let grandchild = find_child_of(child.process.id());
        (child, grandchild)
    }

    // A lasting child of the command shell running `arguments`.
    fn spawn_shell(arguments: &[&str]) -> LastingChild {
        let shell = std::env::var_os("ComSpec").expect("Windows names its command shell");
        spawn_lasting_child(LastingCommand {
            program: shell.into(),
            arguments: arguments
                .iter()
                .map(|&argument| argument.to_owned())
                .collect(),
            environment: std::env::vars().collect(),
            working_folder: std::env::temp_dir(),
            error_output: tempfile::tempfile().expect("the error output file is made"),
        })
        .expect("the lasting child starts")
    }

    // A child of process `parent`, pinned, once one has started; fails the test after ten seconds.
    fn find_child_of(parent: u32) -> PinnedProcess {
        let give_up_at = Instant::now() + Duration::from_secs(10);
        let mut system = System::new();
        loop {
            system.refresh_processes(ProcessesToUpdate::All, true);
            let found = system
                .processes()
                .iter()
                .find(|(_, process)| process.parent().map(Pid::as_u32) == Some(parent))
                .map(|(id, _)| id.as_u32());
            if let Some(id) = found {
                return pin_child_process(id).expect("the grandchild pins");
            }
            assert!(Instant::now() < give_up_at, "the child started no process");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
