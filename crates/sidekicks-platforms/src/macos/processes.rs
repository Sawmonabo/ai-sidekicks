//! This process's user's processes and a process's environment, as macOS lists and shows them.

use std::io;
use std::ptr;
use std::sync::OnceLock;

use crate::posix::process::id::system_process_id;

// `<libproc.h>`'s `PROC_UID_ONLY` and `PROC_PPID_ONLY`, which `libc` does not bind: list the
// processes of one user id, or the children of one process.
const PROC_UID_ONLY: u32 = 4;
const PROC_PPID_ONLY: u32 = 6;

// `<sys/proc_info.h>`'s `PROC_PGRP_ONLY`, which `libc` does not bind: list one process group.
const PROC_PGRP_ONLY: u32 = 2;

// The bytes of one process id in `proc_listpids`' answer.
const PROCESS_ID_BYTES: usize = size_of::<libc::pid_t>();

// The bytes of the argument count that opens a `KERN_PROCARGS2` answer.
const ARGUMENT_COUNT_BYTES: usize = size_of::<libc::c_int>();

// The most bytes a process's arguments and environment take together (`KERN_ARGMAX`), read once.
static ARGUMENT_BYTES: OnceLock<usize> = OnceLock::new();

/// The ids of the processes this process's user runs. Blocks on the read; fails with the system's
/// error when macOS refuses the list.
pub fn list_user_process_ids() -> io::Result<Vec<u32>> {
    list_process_ids(PROC_UID_ONLY, nix::unistd::getuid().as_raw())
}

/// The ids of process `parent_id`'s children, as `proc_listchildpids` lists them. Blocks on the
/// read; fails with the system's error when macOS refuses the list.
pub(crate) fn list_child_process_ids(parent_id: u32) -> io::Result<Vec<u32>> {
    list_process_ids(PROC_PPID_ONLY, parent_id)
}

/// The ids of the processes in group `group_id`. Blocks on the read; fails with the system's error
/// when macOS refuses the list.
pub(crate) fn list_group_process_ids(group_id: u32) -> io::Result<Vec<u32>> {
    list_process_ids(PROC_PGRP_ONLY, group_id)
}

// The ids of the processes `kind` and `value` select.
fn list_process_ids(kind: u32, value: u32) -> io::Result<Vec<u32>> {
    // SAFETY: a null buffer of zero bytes asks only for the bytes the list needs.
    let needed_bytes = unsafe { libc::proc_listpids(kind, value, ptr::null_mut(), 0) };
    if needed_bytes < 0 {
        return Err(io::Error::last_os_error());
    }
    // The list can grow between the size read and the read, so the buffer has room to spare.
    let buffer_bytes = needed_bytes.saturating_mul(2);
    let mut buffer = vec![0_u8; usize::try_from(buffer_bytes).map_err(io::Error::other)?];
    // SAFETY: the buffer is live, owned here and `buffer_bytes` long, and nothing else reads it
    // until the call returns.
    let written_bytes =
        unsafe { libc::proc_listpids(kind, value, buffer.as_mut_ptr().cast(), buffer_bytes) };
    if written_bytes < 0 {
        return Err(io::Error::last_os_error());
    }
    let written_bytes = usize::try_from(written_bytes)
        .map_err(io::Error::other)?
        .min(buffer.len());
    let (process_ids, _partial) = buffer[..written_bytes].as_chunks::<PROCESS_ID_BYTES>();
    Ok(process_ids
        .iter()
        .filter_map(|bytes| {
            let process_id = libc::pid_t::from_ne_bytes(*bytes);
            u32::try_from(process_id).ok().filter(|id| *id > 0)
        })
        .collect())
}

/// The environment process `process_id` started with, one `NAME=value` entry each, bytes that are
/// not UTF-8 read lossily; `None` when the system refuses the process (it ended, or another user
/// runs it) or shows no environment, as it shows none for its own programs. Blocks on the read;
/// fails with the system's error on any other refusal.
pub fn read_process_environment(process_id: u32) -> io::Result<Option<Vec<String>>> {
    let Ok(pid) = system_process_id(process_id) else {
        return Ok(None);
    };
    let argument_bytes = if let Some(bytes) = ARGUMENT_BYTES.get() {
        *bytes
    } else {
        let bytes = read_argument_bytes()?;
        *ARGUMENT_BYTES.get_or_init(|| bytes)
    };
    // Allocated per read and freed after it, so no buffer the size of the limit stays held.
    let mut buffer = vec![0_u8; argument_bytes];
    let mut length = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid.get()];
    // SAFETY: `name` holds three integers, the buffer is live and `length` long, and nothing else
    // reads either until the call returns.
    let status = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut length,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        // A process that ended or that the system hides from this user is refused as invalid.
        return match error.raw_os_error() {
            Some(libc::EINVAL | libc::EPERM | libc::ESRCH) => Ok(None),
            _ => Err(error),
        };
    }
    buffer.truncate(length);
    Ok(environment_in(&buffer))
}

// `KERN_ARGMAX`: the most bytes a process's arguments and environment take together.
fn read_argument_bytes() -> io::Result<usize> {
    let mut argument_bytes: libc::c_int = 0;
    let mut length = size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `name` holds two integers, the answer is one live `c_int` of `length` bytes, and
    // nothing else reads either until the call returns.
    let status = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut argument_bytes).cast(),
            &raw mut length,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    usize::try_from(argument_bytes).map_err(io::Error::other)
}

// A `KERN_PROCARGS2` answer is the argument count, then the executable's path, padding, each
// argument and each environment entry, each ended by a zero byte, and the environment by an empty
// entry; the environment's entries, or `None` when there are none.
fn environment_in(answer: &[u8]) -> Option<Vec<String>> {
    let (count_bytes, strings) = answer.split_at_checked(ARGUMENT_COUNT_BYTES)?;
    let argument_count = libc::c_int::from_ne_bytes(count_bytes.try_into().ok()?);
    let argument_count = usize::try_from(argument_count).ok()?;
    let environment: Vec<String> = strings
        .split(|byte| *byte == 0)
        // The executable's path, then the padding after it, a run of empty entries.
        .skip(1)
        .skip_while(|entry| entry.is_empty())
        .skip(argument_count)
        .take_while(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).into_owned())
        .collect();
    (!environment.is_empty()).then_some(environment)
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    use crate::{list_user_process_ids, read_process_environment};

    // The marker the child carries, and the value it carries it with.
    const PROBE_NAME: &str = "SIDEKICKS_PROBE";
    const PROBE_ENTRY: &str = "SIDEKICKS_PROBE=1";

    // How long the child waits, which bounds the test if it is never killed.
    const CHILD_WAIT: Duration = Duration::from_secs(5);

    // macOS hides the environment of its own programs, so the child is this test program, run
    // again on this one test, which waits when it carries the marker.
    #[test]
    fn a_child_s_environment_and_id_read_back() {
        if std::env::var_os(PROBE_NAME).is_some() {
            thread::sleep(CHILD_WAIT);
            return;
        }
        let test_name = module_path!()
            .split_once("::")
            .map_or(module_path!(), |(_, path)| path);
        let mut child = Command::new(std::env::current_exe().expect("the test program is known"))
            .args([
                "--exact",
                &format!("{test_name}::a_child_s_environment_and_id_read_back"),
            ])
            .env(PROBE_NAME, "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");
        let child_id = child.id();

        let environment = read_process_environment(child_id);
        let user_processes = list_user_process_ids();
        child.kill().expect("the child is killed");
        child.wait().expect("the child is reaped");

        let environment = environment
            .expect("the environment reads")
            .expect("the child shows an environment");
        assert!(environment.iter().any(|entry| entry == PROBE_ENTRY));
        assert!(
            user_processes
                .expect("the user's processes list")
                .contains(&child_id)
        );
    }
}
