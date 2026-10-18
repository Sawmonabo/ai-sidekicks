//! A process pinned on Windows by an open handle, which keeps its id from passing to another
//! process while it lives: a pinned process's record, its re-pin from a record and its stop, which
//! ends the whole job a lasting child runs in.

use std::io::{self, ErrorKind};
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::sync::Arc;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, FALSE, FILETIME, HANDLE, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{IsProcessInJob, OpenJobObjectW, TerminateJobObject};
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

use crate::child_command::ChildEnd;
use crate::pinned_process::{KILL_WAIT_BOUND, ProcessRecord};
use crate::windows::error_codes::win32_code;

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
    /// waits up to `grace` for its exit, then kills it, with its whole job when it runs in one of
    /// its own; blocking, so it runs in `spawn_blocking`. Answers the end that took effect; fails
    /// with `TimedOut` when it outlives the kill's bound, else with the system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        if self.wait_for_exit(grace)? {
            return Ok(ChildEnd::Stop);
        }
        // The creation time read through the open handle confirms the process still runs before
        // its job is ended.
        if self.record()?.is_none() {
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

    // Ends the job of the process's own, every process in it; `false` when it has none, or the
    // job of that name no longer holds the process.
    fn terminate_job(&self) -> io::Result<bool> {
        let Some(name) = &self.job else {
            return Ok(false);
        };
        let wide_name: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain([0])
            .collect();
        // SAFETY: the name is a live NUL-ended UTF-16 string; the call answers a new handle or
        // null.
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
                return Ok(false);
            }
            return Err(error);
        }
        // SAFETY: the handle was just opened and is owned by nothing else.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut is_in_job = FALSE;
        // SAFETY: both handles are open, the job's with the right to query it, and the result
        // points at a live `BOOL`.
        if unsafe { IsProcessInJob(self.handle(), job.as_raw_handle(), &raw mut is_in_job) }
            == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        if is_in_job == FALSE {
            return Ok(false);
        }
        // SAFETY: the job's handle is open and carries the right to end it.
        if unsafe { TerminateJobObject(job.as_raw_handle(), KILLED_EXIT_CODE) } == FALSE {
            return Err(io::Error::last_os_error());
        }
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

/// The process `record` names, held open; `None` when it has ended or its id now names another
/// process, whose creation time differs. Fails with the system's error.
pub(crate) fn pin_recorded(record: &ProcessRecord) -> io::Result<Option<PinnedProcess>> {
    let mut process = match open_process(record.id) {
        Ok(process) => process,
        // No process has the id.
        Err(error) if win32_code(&error) == Some(ERROR_INVALID_PARAMETER) => return Ok(None),
        Err(error) => return Err(error),
    };
    process.job.clone_from(&record.job);
    Ok(process
        .record()?
        .filter(|read| read == record)
        .map(|_| process))
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
