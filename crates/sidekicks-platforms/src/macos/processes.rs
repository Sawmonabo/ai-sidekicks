//! This process's user's processes, as macOS lists them, and the reader of libproc's lists that
//! every process read here shares.

use std::io;

use libc::{c_int, c_void};
use nix::errno::Errno;

// `<libproc.h>`'s `PROC_UID_ONLY` and `PROC_PPID_ONLY`, which `libc` does not bind: list the
// processes of one user id, or the children of one process.
const PROC_UID_ONLY: u32 = 4;
const PROC_PPID_ONLY: u32 = 6;

// `<sys/proc_info.h>`'s `PROC_PGRP_ONLY`, which `libc` does not bind: list one process group.
const PROC_PGRP_ONLY: u32 = 2;

// The entries a list's first read makes room for, doubled while the list does not fit.
const LIST_START_LENGTH: usize = 64;

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
    let process_ids: Vec<libc::pid_t> = read_list(ListLength::Bytes, |buffer, length| {
        // SAFETY: the buffer is live and `length` bytes long, sized for whole ids, and nothing else
        // reads it until the call returns.
        unsafe { libc::proc_listpids(kind, value, buffer, length) }
    })?;
    Ok(process_ids
        .into_iter()
        .filter_map(|process_id| u32::try_from(process_id).ok().filter(|id| *id > 0))
        .collect())
}

/// The list `proc_pidinfo` answers in bytes for `flavor` of process `pid`, in entries of `T`.
/// Blocks on the read; fails with the system's error when macOS refuses it.
pub(crate) fn read_pid_list<T>(pid: c_int, flavor: c_int) -> io::Result<Vec<T>> {
    read_list(ListLength::Bytes, |buffer, length| {
        // SAFETY: the buffer is live and `length` bytes long, sized for whole entries, and nothing
        // else reads it until the call returns.
        unsafe { libc::proc_pidinfo(pid, flavor, 0, buffer, length) }
    })
}

/// A list whose libproc `call` answers how many entries the kernel holds, which may be more than
/// it wrote into the buffer and length it is given. Fails with the system's error the call sets.
pub(crate) fn read_counted_list<T>(
    call: impl FnMut(*mut c_void, c_int) -> c_int,
) -> io::Result<Vec<T>> {
    read_list(ListLength::Count, call)
}

// What a list call's answer counts.
#[derive(Clone, Copy)]
enum ListLength {
    // The bytes it wrote, a full buffer meaning more may be left.
    Bytes,
    // The entries the kernel holds, written up to the buffer's room.
    Count,
}

// The entries of type `T` a libproc list call writes into a buffer it is given, the buffer grown
// until the whole list fits.
fn read_list<T>(
    length_kind: ListLength,
    mut call: impl FnMut(*mut c_void, c_int) -> c_int,
) -> io::Result<Vec<T>> {
    let mut capacity = LIST_START_LENGTH;
    loop {
        let mut entries = Vec::<T>::with_capacity(capacity);
        let length = c_int::try_from(capacity * size_of::<T>()).map_err(io::Error::other)?;
        let answered = read_libproc_count(|| call(entries.as_mut_ptr().cast(), length))?;
        let (written, is_whole) = match length_kind {
            ListLength::Bytes => (
                answered / size_of::<T>(),
                answered < capacity * size_of::<T>(),
            ),
            ListLength::Count => (answered, answered <= capacity),
        };
        if is_whole {
            // SAFETY: the call wrote `written` whole entries from the buffer's start, within its
            // capacity.
            unsafe { entries.set_len(written) };
            return Ok(entries);
        }
        capacity = written.max(capacity).saturating_mul(2);
    }
}

/// Runs a libproc `call` answering a count, which answers 0 both when it fails and when it found
/// nothing, so `errno`, cleared first, tells the two apart. Fails with the error the call sets.
pub(crate) fn read_libproc_count(call: impl FnOnce() -> c_int) -> io::Result<usize> {
    Errno::clear();
    let count = call();
    match usize::try_from(count) {
        Ok(count) if count > 0 => Ok(count),
        _ => match Errno::last_raw() {
            0 => Ok(0),
            code => Err(io::Error::from_raw_os_error(code)),
        },
    }
}
