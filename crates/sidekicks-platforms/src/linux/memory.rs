//! A process's peak memory and the machine's available memory as Linux reports them, its control
//! group's limits counted, the switch that keeps transparent huge pages off the daemon, and the
//! measurement tests' footprint read.

use std::error::Error;
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(test, feature = "test-support"))]
use crate::footprint::ProcessFootprint;
use crate::linux::read_process_file;
use crate::posix::memory::page_bytes;

// The control groups this process belongs to, one `id:controllers:path` line each.
const PROCESS_CGROUP_PATH: &str = "/proc/self/cgroup";

// The kernel's memory counters, one `Name:   value kB` line each.
const MEMORY_INFO_PATH: &str = "/proc/meminfo";

// This process's status, one `Name:   value` line each.
#[cfg(any(test, feature = "test-support"))]
const PROCESS_STATUS_PATH: &str = "/proc/self/status";

// Where the unified (version 2) hierarchy and the version 1 memory controller are mounted.
const CGROUP2_ROOT: &[u8] = b"/sys/fs/cgroup";
const CGROUP1_MEMORY_ROOT: &[u8] = b"/sys/fs/cgroup/memory";

// A version 2 process belongs to one group, written on the one line `0::/<path>`.
const CGROUP2_LINE_START: &[u8] = b"0::/";

// The version 1 memory controller's line: `<id>:memory:/<path>`.
const CGROUP1_MEMORY_FIELD: &[u8] = b":memory:";
const CGROUP1_MEMORY_PATH_START: &[u8] = b":memory:/";

// The word a version 2 limit file holds when no limit is set.
const CGROUP2_NO_LIMIT: &[u8] = b"max\n";

const KIBIBYTE: u64 = 1024;

// Set once a control group file failed to read for a reason other than its absence.
static HAS_LOGGED_CGROUP_READ_FAILURE: AtomicBool = AtomicBool::new(false);

/// The most memory process `process_id` has held since it started, in bytes, from `VmHWM` in its
/// status file; `None` when no process has the id or it holds no memory of its own, as a process
/// that exited and is not yet reaped and a kernel thread show no memory lines. Blocks on the
/// read; fails with `InvalidData` when the peak passes the largest size, and with the read's error
/// otherwise.
pub fn read_process_peak_bytes(process_id: u32) -> io::Result<Option<u64>> {
    let Some(status) = read_process_file(process_id, "status")? else {
        return Ok(None);
    };
    let Some(kibibytes) = status_kibibytes(&status, b"VmHWM:") else {
        return Ok(None);
    };
    kibibytes
        .checked_mul(KIBIBYTE)
        .map(Some)
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "the peak passes the largest size"))
}

/// This process's footprint as Linux reports it, from one read of `/proc/self/status`: its
/// approximate resident set now (`VmRSS`) and at its peak (`VmHWM`). Fails with `InvalidData`
/// naming the line when either is missing, unparsable or past the largest size, and with the
/// read's error otherwise.
#[cfg(any(test, feature = "test-support"))]
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    let status = std::fs::read(PROCESS_STATUS_PATH)?;
    let bytes_on = |name: &str| {
        status_kibibytes(&status, name.as_bytes())
            .and_then(|kibibytes| kibibytes.checked_mul(KIBIBYTE))
            .ok_or_else(|| {
                io::Error::new(ErrorKind::InvalidData, format!("no readable `{name}` line"))
            })
    };
    Ok(ProcessFootprint {
        current_bytes: bytes_on("VmRSS:")?,
        peak_bytes: bytes_on("VmHWM:")?,
        tool_line: "no footprint tool on Linux".to_string(),
    })
}

/// The memory the machine can give this process, in bytes: when its control group sets a limit no
/// larger than the installed memory, that limit less the group's use (0 past it), else the
/// kernel's `MemAvailable`, else the free memory `sysinfo(2)` reports. A control group file that
/// cannot be read counts as no limit, as libuv reads it. Blocks on the reads; fails with the read's
/// error when `/proc/self/cgroup` cannot be read, when `/proc/meminfo` is there but cannot be
/// read, or when `sysinfo(2)` fails.
pub fn available_memory() -> io::Result<u64> {
    let cgroup = std::fs::read(PROCESS_CGROUP_PATH)?;
    let constrained = constrained_memory(&cgroup)?;
    if constrained == 0 || constrained > total_memory()? {
        return free_memory();
    }
    let current = if is_cgroup2(&cgroup) {
        read_cgroup_value(CGROUP2_ROOT, cgroup2_path(&cgroup), "memory.current")
    } else {
        cgroup1_current_memory(&cgroup)
    };
    // A group's use can pass its limit for a moment.
    Ok(constrained.saturating_sub(current))
}

/// Turns transparent huge pages off for this process and the children it starts later, so the
/// allocator's idle memory stays in small pages. Fails with the system's error when the kernel
/// refuses.
pub fn turn_off_transparent_huge_pages() -> io::Result<()> {
    Ok(nix::sys::prctl::set_thp_disable(true)?)
}

// The lower of the group's soft and hard limits, or 0 when either reads as none.
fn constrained_memory(cgroup: &[u8]) -> io::Result<u64> {
    let (high, max) = if is_cgroup2(cgroup) {
        let path = cgroup2_path(cgroup);
        (
            read_cgroup_value(CGROUP2_ROOT, path, "memory.high"),
            read_cgroup_value(CGROUP2_ROOT, path, "memory.max"),
        )
    } else {
        cgroup1_limits(cgroup)?
    };
    if high == 0 || max == 0 {
        return Ok(0);
    }
    Ok(high.min(max))
}

// The version 1 group's soft and hard limits, falling back to the root group's when the group's
// own files read as none; version 1's own "no limit", the largest page-aligned `long`, reads as
// `u64::MAX` as version 2's `max` does.
fn cgroup1_limits(cgroup: &[u8]) -> io::Result<(u64, u64)> {
    let mut limits = (0, 0);
    if let Some(path) = cgroup1_memory_path(cgroup) {
        limits = (
            read_cgroup_value(CGROUP1_MEMORY_ROOT, path, "memory.soft_limit_in_bytes"),
            read_cgroup_value(CGROUP1_MEMORY_ROOT, path, "memory.limit_in_bytes"),
        );
    }
    if limits.0 == 0 || limits.1 == 0 {
        limits = (
            read_cgroup_value(CGROUP1_MEMORY_ROOT, b"", "memory.soft_limit_in_bytes"),
            read_cgroup_value(CGROUP1_MEMORY_ROOT, b"", "memory.limit_in_bytes"),
        );
    }
    let page_mask = page_bytes()? - 1;
    let no_limit = u64::try_from(libc::c_long::MAX).map_err(io::Error::other)? & !page_mask;
    let lift = |limit: u64| if limit == no_limit { u64::MAX } else { limit };
    Ok((lift(limits.0), lift(limits.1)))
}

// The version 1 group's memory use, or the root group's when the group's own file reads as none.
fn cgroup1_current_memory(cgroup: &[u8]) -> u64 {
    if let Some(path) = cgroup1_memory_path(cgroup) {
        let current = read_cgroup_value(CGROUP1_MEMORY_ROOT, path, "memory.usage_in_bytes");
        if current != 0 {
            return current;
        }
    }
    read_cgroup_value(CGROUP1_MEMORY_ROOT, b"", "memory.usage_in_bytes")
}

fn is_cgroup2(cgroup: &[u8]) -> bool {
    cgroup.starts_with(CGROUP2_LINE_START)
}

// The version 2 group's path after its leading `/`, up to the line's end.
fn cgroup2_path(cgroup: &[u8]) -> &[u8] {
    line_start(&cgroup[CGROUP2_LINE_START.len()..])
}

// The version 1 memory controller's group path after its leading `/`, found as the first line whose
// controller field, read from its first `:`, opens `:memory:`; `None` when no line does.
fn cgroup1_memory_path(cgroup: &[u8]) -> Option<&[u8]> {
    let find = |from: usize, wanted: u8| {
        let offset = cgroup
            .get(from..)?
            .iter()
            .position(|byte| *byte == wanted)?;
        Some(from + offset)
    };
    let mut colon = find(0, b':')?;
    while !cgroup[colon..].starts_with(CGROUP1_MEMORY_FIELD) {
        colon = find(find(colon, b'\n')?, b':')?;
    }
    let path_start = (colon + CGROUP1_MEMORY_PATH_START.len()).min(cgroup.len());
    Some(line_start(&cgroup[path_start..]))
}

// The bytes before the first line break.
fn line_start(text: &[u8]) -> &[u8] {
    text.split(|byte| *byte == b'\n').next().unwrap_or(text)
}

// The number in the control group file `<root>/<group path>/<file>`, joined as text so an empty
// group path names the root group's file: its leading digits after any whitespace, `u64::MAX` for
// version 2's `max`, and 0, which reads as no limit, when the file cannot be read or holds
// neither. A failure other than a missing file is logged once for the daemon's life.
fn read_cgroup_value(root: &[u8], group_path: &[u8], file: &str) -> u64 {
    let mut path = Vec::with_capacity(root.len() + group_path.len() + file.len() + 2);
    path.extend_from_slice(root);
    path.push(b'/');
    path.extend_from_slice(group_path);
    path.push(b'/');
    path.extend_from_slice(file.as_bytes());
    let contents = match std::fs::read(PathBuf::from(OsString::from_vec(path))) {
        Ok(contents) => contents,
        Err(error) => {
            if error.kind() != ErrorKind::NotFound
                && !HAS_LOGGED_CGROUP_READ_FAILURE.swap(true, Ordering::Relaxed)
            {
                tracing::warn!(
                    file,
                    error = &error as &(dyn Error + 'static),
                    "a control group file could not be read, so its limit counts as none"
                );
            }
            return 0;
        }
    };
    leading_number(&contents).unwrap_or(if contents == CGROUP2_NO_LIMIT {
        u64::MAX
    } else {
        0
    })
}

// The kernel's `MemAvailable`, or, when it reads as none, the free memory `sysinfo(2)` reports.
fn free_memory() -> io::Result<u64> {
    match read_memory_info(b"MemAvailable:")? {
        0 => Ok(nix::sys::sysinfo::sysinfo()?.ram_unused()),
        available => Ok(available),
    }
}

// The kernel's `MemTotal`, or, when it reads as none, the total memory `sysinfo(2)` reports.
fn total_memory() -> io::Result<u64> {
    match read_memory_info(b"MemTotal:")? {
        0 => Ok(nix::sys::sysinfo::sysinfo()?.ram_total()),
        total => Ok(total),
    }
}

// The kibibytes after the first `name` in `/proc/meminfo`, in bytes; 0 when the file is missing or
// the value is.
fn read_memory_info(name: &[u8]) -> io::Result<u64> {
    let memory_info = match std::fs::read(MEMORY_INFO_PATH) {
        Ok(memory_info) => memory_info,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let Some(start) = memory_info
        .windows(name.len())
        .position(|window| window == name)
    else {
        return Ok(0);
    };
    let kibibytes = leading_number(&memory_info[start + name.len()..]).unwrap_or(0);
    Ok(kibibytes.saturating_mul(KIBIBYTE))
}

// The decimal number at the start of `text` after any ASCII whitespace, `u64::MAX` when it passes
// that, or `None` when no digit comes first.
fn leading_number(text: &[u8]) -> Option<u64> {
    let text = text.trim_ascii_start();
    let digits = &text[..text.iter().take_while(|byte| byte.is_ascii_digit()).count()];
    if digits.is_empty() {
        return None;
    }
    Some(digits.iter().fold(0_u64, |number, digit| {
        number
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
    }))
}

// The kibibytes on the first line `name` of the status file `status`; `None` when no line reads.
fn status_kibibytes(status: &[u8], name: &[u8]) -> Option<u64> {
    status
        .split(|byte| *byte == b'\n')
        .find_map(|line| kibibytes_after(line, name))
}

// The kibibytes on a status line `name`, whitespace, digits and ` kB`; `None` for any other line.
fn kibibytes_after(line: &[u8], name: &[u8]) -> Option<u64> {
    let value = line.strip_prefix(name)?;
    if !value.first().is_some_and(u8::is_ascii_whitespace) {
        return None;
    }
    let value = value.trim_ascii_start();
    let digits = value.strip_suffix(b" kB")?;
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}
