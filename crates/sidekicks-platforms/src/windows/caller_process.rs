//! Which process is at the other end of a local connection, and a process's parent, on Windows,
//! which reads neither yet; a process held open by its handle, its record, its re-pin and its stop.

use std::io::{self, ErrorKind};
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::tokio::Stream;
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, FALSE, FILETIME, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

use crate::caller_process::{KILL_WAIT_BOUND, ParentProcess, ProcessRecord};
use crate::child_command::ChildEnd;
use crate::windows::error_codes::win32_code;

// The exit code a killed process is given.
const KILLED_EXIT_CODE: u32 = 1;

/// A process, held by its id and an open handle, which keeps its id from passing to another
/// process while the handle lives; this process is held by its id alone.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    id: u32,
    // `None` for this process, read through its pseudo-handle.
    process: Option<Arc<OwnedHandle>>,
}

impl PinnedProcess {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The record a later process re-pins this one from; `None` once it has ended. Fails with the
    /// system's error.
    pub fn record(&self) -> io::Result<Option<ProcessRecord>> {
        if self.wait_for_exit(Duration::ZERO)? {
            return Ok(None);
        }
        read_creation_time(self.handle()).map(|start| Some(ProcessRecord::new(self.id, start)))
    }

    /// Ends the process, which the caller has already asked to stop by the program's own means:
    /// waits up to `grace` for its exit, then kills it; blocking, so it runs in `spawn_blocking`.
    /// Answers the end that took effect; fails with `TimedOut` when it outlives the kill's bound,
    /// else with the system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        if self.wait_for_exit(grace)? {
            return Ok(ChildEnd::Stop);
        }
        // SAFETY: the handle is open while `self` lives and carries the right to end the process.
        if unsafe { TerminateProcess(self.handle(), KILLED_EXIT_CODE) } == FALSE {
            let error = io::Error::last_os_error();
            // Windows refuses the end of a process already ending; the wait below tells.
            if !self.wait_for_exit(Duration::ZERO)? {
                return Err(error);
            }
        }
        if self.wait_for_exit(KILL_WAIT_BOUND)? {
            return Ok(ChildEnd::Kill);
        }
        Err(io::Error::new(
            ErrorKind::TimedOut,
            "the process still runs after it was killed",
        ))
    }

    fn handle(&self) -> HANDLE {
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

impl ProcessRecord {
    /// The process this record names, held open; `None` when it has ended or its id now names
    /// another process. Fails with the system's error.
    pub fn pin(self) -> io::Result<Option<PinnedProcess>> {
        let process = match open_process(self.id()) {
            Ok(process) => process,
            // No process has the id.
            Err(error) if win32_code(&error) == Some(ERROR_INVALID_PARAMETER) => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(process
            .record()?
            .filter(|record| *record == self)
            .map(|_| process))
    }
}

/// The caller's own child `id`, held open; the caller's handle to the child keeps its id from
/// passing to another process meanwhile. Fails with the system's error, `ERROR_INVALID_PARAMETER`
/// when no process has the id.
pub fn pin_child_process(id: u32) -> io::Result<PinnedProcess> {
    open_process(id)
}

/// Reads no peer: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_peer_process(_stream: &Stream) -> io::Result<Option<PinnedProcess>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no local connection's peer process yet",
    ))
}

/// Reads no parent: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_parent_process(_process: &PinnedProcess) -> io::Result<ParentProcess> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no process's parent yet",
    ))
}

/// This process, held by its id.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    PinnedProcess {
        id: std::process::id(),
        process: None,
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
