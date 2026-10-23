//! This process's user's processes, as macOS lists them.

use std::io;
use std::ptr;

// `<libproc.h>`'s `PROC_UID_ONLY` and `PROC_PPID_ONLY`, which `libc` does not bind: list the
// processes of one user id, or the children of one process.
const PROC_UID_ONLY: u32 = 4;
const PROC_PPID_ONLY: u32 = 6;

// `<sys/proc_info.h>`'s `PROC_PGRP_ONLY`, which `libc` does not bind: list one process group.
const PROC_PGRP_ONLY: u32 = 2;

// The bytes of one process id in `proc_listpids`' answer.
const PROCESS_ID_BYTES: usize = size_of::<libc::pid_t>();

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
