//! What a process started with, its arguments and its environment, as Linux shows them under
//! `/proc`.

use std::io;

use crate::linux::read_process_file;
use crate::process_start::ProcessStart;

/// The arguments and environment process `process_id` started with, bytes that are not UTF-8 read
/// lossily; `None` when the system refuses the read because the process ended or another user runs
/// it, and when it shows no arguments: a process its parent just started, whose exec has not yet
/// set them, as the parent can see once its own wait on the start returns, or a kernel thread.
/// Blocks on the reads; fails with the system's error on any other refusal.
pub fn read_process_start(process_id: u32) -> io::Result<Option<ProcessStart>> {
    let Some(arguments) =
        read_entries(process_id, "cmdline")?.filter(|entries| !entries.is_empty())
    else {
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

// The zero-ended entries of `/proc/<process_id>/<file>`; `None` when the process ended or another
// user runs it.
fn read_entries(process_id: u32, file: &str) -> io::Result<Option<Vec<String>>> {
    let bytes = match read_process_file(process_id, file) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::EACCES) => return Ok(None),
        Err(error) => return Err(error),
    };
    // Each entry ends in a zero byte, and a file with no entries is empty.
    if bytes.is_empty() {
        return Ok(Some(Vec::new()));
    }
    Ok(Some(
        bytes
            .strip_suffix(&[0])
            .unwrap_or(&bytes)
            .split(|byte| *byte == 0)
            .map(|entry| String::from_utf8_lossy(entry).into_owned())
            .collect(),
    ))
}
