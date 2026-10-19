//! A child leading a tree of its own on Windows: in a job of its own that opens no console window
//! and that closing the daemon's handle does not end, whose tree ends by ending that job, and the
//! read of what its output pipes hold at its exit.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::ptr;
use std::time::Duration;

use ::windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
use process_wrap::tokio::{ChildWrapper, CommandWrap, CreationFlags, JobObject};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::process::Command;
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED};
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::child_tree::{ChildTreeOutputError, OUTPUT_READ_CHUNK, check_output_bound};
use crate::windows::error_codes::win32_code;

/// How long an output read is awaited when a cancel found none under way, before the cancel is
/// sent again, for a read whose blocking thread had not yet reached the system.
const READ_START_WAIT: Duration = Duration::from_millis(20);

/// How many times the cancel is sent before the read is left to its blocking thread.
const CANCEL_ATTEMPTS: u32 = 5;

/// Starts `command` in a job of its own that opens no console window and that closing its handle
/// does not end, so a process the child leaves behind runs on after a normal exit. Fails with the
/// spawn's error or the job's.
pub(crate) fn spawn_child_tree_process(
    mut command: Command,
    _daemon_pid: u32,
) -> io::Result<Box<dyn ChildWrapper>> {
    command.kill_on_drop(true);
    let mut wrap = CommandWrap::from(command);
    // The job sets the creation flags itself, from this wrapper alone.
    wrap.wrap(CreationFlags(PROCESS_CREATION_FLAGS(CREATE_NO_WINDOW)))
        .wrap(JobObject);
    wrap.spawn()
}

/// Ends every process in the child's job on this thread. Fails with the system's error.
pub(crate) fn end_child_tree_now(process: &mut dyn ChildWrapper) -> io::Result<()> {
    process.start_kill()
}

/// Reads what `stream` holds once its child has exited, without waiting for an end of file a
/// process left in the job can hold off. tokio reads a child's pipe here as a blocking file on a
/// blocking thread, so a read is under way at the exit and would hold that thread until such a
/// process ends: it is canceled and its bytes kept, then the pipe is read as `PeekNamedPipe`
/// reports it holds, exactly that many bytes each time, until it holds none. A read no cancel
/// reaches is left to its thread, logged, and what was read returned. Fails with `TooLarge` once
/// `into` passes `bound`, else with the cancel's, a read's or the peek's error.
pub(crate) async fn read_output_left_at_exit(
    stream: Option<&mut (impl AsyncRead + AsRawHandle + Unpin)>,
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<(), ChildTreeOutputError> {
    let Some(stream) = stream else {
        return Ok(());
    };
    if !collect_canceled_read(stream, into, bound).await? {
        // The read left under way waits on the pipe's handle, so no other call touches it.
        return Ok(());
    }
    loop {
        let held = bytes_held(stream).map_err(ChildTreeOutputError::Io)?;
        if held == 0 {
            return Ok(());
        }
        into.reserve(usize::try_from(held).expect("a pipe's held count fits in memory"));
        let count = (&mut *stream)
            .take(u64::from(held))
            .read_buf(into)
            .await
            .map_err(ChildTreeOutputError::Io)?;
        if count == 0 {
            return Ok(());
        }
        check_output_bound(into, bound)?;
    }
}

// Ends the read tokio left under way at the exit, keeping what it had read, and answers whether
// no read is under way on the pipe now. A read the cancel finds is awaited to its end; one it
// misses, its thread not yet in the system call, is given a moment and canceled again; one that
// outlives every cancel is left to its thread and logged.
async fn collect_canceled_read(
    stream: &mut (impl AsyncRead + AsRawHandle + Unpin),
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<bool, ChildTreeOutputError> {
    for _ in 0..CANCEL_ATTEMPTS {
        let is_read_canceled = cancel_reads(stream).map_err(ChildTreeOutputError::Io)?;
        // A read under way was sized to one chunk, so this much room takes all it read.
        into.reserve(OUTPUT_READ_CHUNK);
        let mut chunk = (&mut *stream)
            .take(u64::try_from(OUTPUT_READ_CHUNK).expect("a chunk's size fits in 64 bits"));
        let chunk = chunk.read_buf(into);
        let read = if is_read_canceled {
            // The canceled read ends at once, with what it read or as aborted.
            chunk.await
        } else {
            match tokio::time::timeout(READ_START_WAIT, chunk).await {
                Ok(read) => read,
                Err(_elapsed) => continue,
            }
        };
        return match read {
            Ok(_count) => check_output_bound(into, bound).map(|()| true),
            Err(error) if win32_code(&error) == Some(ERROR_OPERATION_ABORTED) => Ok(true),
            Err(error) => Err(ChildTreeOutputError::Io(error)),
        };
    }
    tracing::warn!(
        "a process left in a child's job holds its output pipe, so a read of it keeps a blocking \
         thread until that process writes or ends"
    );
    Ok(false)
}

// Cancels every read under way on the pipe end `stream` reads: `true` when one was found, which
// then ends as aborted, `false` when none was under way. Fails with the system's error.
fn cancel_reads(stream: &impl AsRawHandle) -> io::Result<bool> {
    // SAFETY: the handle is the pipe end `stream` owns, open for the whole call, and a null
    // overlapped pointer cancels every read under way on it. The end is opened overlapped, so the
    // cancel reaches a read another thread waits on.
    let is_canceled = unsafe { CancelIoEx(stream.as_raw_handle(), ptr::null()) };
    if is_canceled != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if win32_code(&error) == Some(ERROR_NOT_FOUND) {
        return Ok(false);
    }
    Err(error)
}

// How many bytes the pipe `stream` reads holds now; 0 once it is empty and every writer closed it.
fn bytes_held(stream: &impl AsRawHandle) -> io::Result<u32> {
    let mut held = 0;
    // SAFETY: the handle is the pipe end `stream` owns, open for the whole call, and no read is
    // under way on it, so no blocking read's wait on the handle can wake at this call's end; no
    // bytes are copied, so no buffer is passed, and `held` outlives the call.
    let is_peeked = unsafe {
        PeekNamedPipe(
            stream.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &raw mut held,
            ptr::null_mut(),
        )
    };
    if is_peeked != 0 {
        return Ok(held);
    }
    let error = io::Error::last_os_error();
    if win32_code(&error) == Some(ERROR_BROKEN_PIPE) {
        return Ok(0);
    }
    Err(error)
}
