//! A process's peak working set and the machine's available memory as Windows reports them.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FALSE};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::windows::error_codes::win32_code;

/// The most memory process `process_id` has held since it started, in bytes, its peak working
/// set; `None` when no process has the id or another user runs it. Blocks on the read; fails with
/// the system's error on any other refusal.
pub fn read_process_peak_bytes(process_id: u32) -> io::Result<Option<u64>> {
    // SAFETY: the call takes plain values and answers a new handle or null.
    let raw_process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id) };
    if raw_process.is_null() {
        return absent_or_failed(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened and is owned by nothing else, so it closes on every path.
    let process = unsafe { OwnedHandle::from_raw_handle(raw_process) };
    let counters_size = u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>())
        .expect("the record's size fits in a u32");
    // SAFETY: `PROCESS_MEMORY_COUNTERS` is a C struct of integers, for which all zero bytes are
    // valid.
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = counters_size;
    // SAFETY: the handle is open, and the record is live and `counters_size` bytes long; nothing
    // else reads it until the call returns.
    let has_read = unsafe {
        K32GetProcessMemoryInfo(process.as_raw_handle(), &raw mut counters, counters_size)
    };
    if has_read == FALSE {
        return absent_or_failed(io::Error::last_os_error());
    }
    u64::try_from(counters.PeakWorkingSetSize)
        .map(Some)
        .map_err(io::Error::other)
}

/// The memory the machine can give without paging, in bytes: `GlobalMemoryStatusEx`'s available
/// physical memory. Blocks on the read; fails with the system's error when Windows refuses it.
pub fn available_memory() -> io::Result<u64> {
    // SAFETY: `MEMORYSTATUSEX` is a C struct of integers, for which all zero bytes are valid.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength =
        u32::try_from(size_of::<MEMORYSTATUSEX>()).expect("the record's size fits in a u32");
    // SAFETY: the record is live and its length is set, as the call requires; nothing else reads
    // it until the call returns.
    if unsafe { GlobalMemoryStatusEx(&raw mut status) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(status.ullAvailPhys)
}

/// Does nothing: transparent huge pages are a Linux setting. Never fails.
pub fn turn_off_transparent_huge_pages() -> io::Result<()> {
    Ok(())
}

// `None` for a process id that names no process or a process another user runs, else the error.
fn absent_or_failed(error: io::Error) -> io::Result<Option<u64>> {
    let code = win32_code(&error);
    if code == Some(ERROR_INVALID_PARAMETER) || code == Some(ERROR_ACCESS_DENIED) {
        return Ok(None);
    }
    Err(error)
}
