//! What a process started with, its arguments and its environment, as Linux shows them under
//! `/proc`.

use std::fs;
use std::io;

use crate::process_start::ProcessStart;

/// The arguments and environment process `process_id` started with, bytes that are not UTF-8 read
/// lossily; `None` when the system refuses the read because the process ended or another user runs
/// it. Blocks on the reads; fails with the system's error on any other refusal.
pub fn read_process_start(process_id: u32) -> io::Result<Option<ProcessStart>> {
    let Some(arguments) = read_entries(process_id, "cmdline")? else {
        return Ok(None);
    };
    let Some(environment) = read_entries(process_id, "environ")? else {
        return Ok(None);
    };
    Ok(Some(ProcessStart {
        arguments,
        environment,
    }))
}

/// The environment process `process_id` started with, one `NAME=value` entry each, bytes that are
/// not UTF-8 read lossily; `None` when the system refuses the read because the process ended or
/// another user runs it. Blocks on the read; fails with the system's error on any other refusal.
pub fn read_process_environment(process_id: u32) -> io::Result<Option<Vec<String>>> {
    read_entries(process_id, "environ")
}

// The zero-ended entries of `/proc/<process_id>/<file>`; `None` when the process ended or another
// user runs it.
fn read_entries(process_id: u32, file: &str) -> io::Result<Option<Vec<String>>> {
    match fs::read(format!("/proc/{process_id}/{file}")) {
        // Each entry ends in a zero byte, and a kernel thread's files are empty.
        Ok(bytes) if bytes.is_empty() => Ok(Some(Vec::new())),
        Ok(bytes) => Ok(Some(
            bytes
                .strip_suffix(&[0])
                .unwrap_or(&bytes)
                .split(|byte| *byte == 0)
                .map(|entry| String::from_utf8_lossy(entry).into_owned())
                .collect(),
        )),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EACCES | libc::ENOENT | libc::ESRCH)
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
