//! The process's memory footprint for the measurement tests, as macOS accounts it; no other system
//! reports one.

use std::io;
#[cfg(target_os = "macos")]
use std::process::Command;

/// The process's footprint as macOS accounts it: the memory the system charges the process now and
/// at its peak, with the line the `footprint` tool prints for it.
#[derive(Debug)]
pub struct ProcessFootprint {
    /// The bytes charged now.
    pub current_bytes: u64,
    /// The most bytes charged since the process began.
    pub peak_bytes: u64,
    /// The `footprint` tool's line for the process, or why it gave none.
    pub tool_line: String,
}

/// This process's footprint. Fails with the system's error when macOS refuses the read.
#[cfg(target_os = "macos")]
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    let process = std::process::id();
    // SAFETY: `rusage_info_v4` is a C struct of integers, for which all zero bytes are valid.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let buffer = (&raw mut info).cast::<libc::rusage_info_t>();
    let pid = libc::pid_t::try_from(process).map_err(io::Error::other)?;
    // SAFETY: `buffer` points at a live `rusage_info_v4`, the struct `RUSAGE_INFO_V4` asks the call
    // to fill, and nothing else reads it until the call returns.
    let status = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, buffer) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    let tool_line = match Command::new("footprint")
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
        current_bytes: info.ri_phys_footprint,
        peak_bytes: info.ri_lifetime_max_phys_footprint,
        tool_line,
    })
}

/// This process's footprint, which only macOS reports. Always fails with `Unsupported`.
#[cfg(not(target_os = "macos"))]
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "only macOS reports a process's footprint",
    ))
}
