//! A process's memory as macOS charges it, the machine's available memory, and the measurement
//! tests' footprint read.

use std::io;
use std::sync::OnceLock;

#[cfg(any(test, feature = "test-support"))]
use crate::footprint::ProcessFootprint;
use crate::posix::memory::page_bytes;
use crate::posix::process::id::system_process_id;

// The program that prints the process's footprint, by its full path so no `PATH` entry stands in
// for it.
#[cfg(any(test, feature = "test-support"))]
const FOOTPRINT_PROGRAM: &str = "/usr/bin/footprint";

// The host port the statistics read asks, taken once and held for the process's life, so repeated
// reads add no send right.
static HOST_PORT: OnceLock<libc::host_t> = OnceLock::new();

/// The most memory process `process_id` has held since it started, in bytes, as its footprint
/// counts it; `None` when no process has the id or it runs as another user. Blocks on the read;
/// fails with the system's error on any other refusal.
pub fn read_process_peak_bytes(process_id: u32) -> io::Result<Option<u64>> {
    // An id the system cannot hold names no process; 0 would reach the kernel's own.
    let Ok(id) = system_process_id(process_id) else {
        return Ok(None);
    };
    match read_resource_usage(id.get()) {
        Ok(usage) => Ok(Some(usage.ri_lifetime_max_phys_footprint)),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM)) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The memory the machine can give without swapping, in bytes: its free, inactive and purgeable
/// pages. Blocks on the read; fails with `Other` when the system refuses the statistics.
pub fn available_memory() -> io::Result<u64> {
    let host_port = *HOST_PORT.get_or_init(|| {
        // SAFETY: the call takes no arguments and only answers this task's host port.
        unsafe { mach2::mach_init::mach_host_self() }
    });
    // SAFETY: `vm_statistics64` is a C struct of integers, for which all zero bytes are valid.
    let mut statistics: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    // SAFETY: the buffer is a live `vm_statistics64` and `count` holds its length in integers, the
    // shape `HOST_VM_INFO64` fills; nothing else reads either until the call returns.
    let status = unsafe {
        libc::host_statistics64(
            host_port,
            libc::HOST_VM_INFO64,
            (&raw mut statistics).cast::<libc::integer_t>(),
            &raw mut count,
        )
    };
    if status != libc::KERN_SUCCESS {
        return Err(io::Error::other(format!(
            "host_statistics64 failed with kernel status {status}"
        )));
    }
    // Copied out by value, since the struct is packed.
    let free = u64::from(statistics.free_count);
    let inactive = u64::from(statistics.inactive_count);
    let purgeable = u64::from(statistics.purgeable_count);
    Ok((free + inactive + purgeable) * page_bytes()?)
}

/// Does nothing: transparent huge pages are a Linux setting. Never fails.
pub fn turn_off_transparent_huge_pages() -> io::Result<()> {
    Ok(())
}

/// This process's footprint. Fails with the system's error when macOS refuses the read.
#[cfg(any(test, feature = "test-support"))]
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    let process = nix::unistd::getpid().as_raw();
    let usage = read_resource_usage(process)?;
    let tool_line = match std::process::Command::new(FOOTPRINT_PROGRAM)
        .arg("-p")
        .arg(process.to_string())
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .find(|line| line.contains("Footprint:"))
            .map_or_else(
                || "no footprint line".to_string(),
                |line| line.trim().to_string(),
            ),
        Err(error) => format!("footprint did not run: {error}"),
    };
    Ok(ProcessFootprint {
        current_bytes: usage.ri_phys_footprint,
        peak_bytes: usage.ri_lifetime_max_phys_footprint,
        tool_line,
    })
}

// The resource usage `proc_pid_rusage` reports for system id `pid`; fails with the system's error.
fn read_resource_usage(pid: libc::pid_t) -> io::Result<libc::rusage_info_v4> {
    // SAFETY: `rusage_info_v4` is a C struct of integers, for which all zero bytes are valid.
    let mut usage: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let buffer = (&raw mut usage).cast::<libc::rusage_info_t>();
    // SAFETY: `buffer` points at a live `rusage_info_v4`, the struct `RUSAGE_INFO_V4` asks the call
    // to fill, and nothing else reads it until the call returns.
    let status = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, buffer) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(usage)
}
