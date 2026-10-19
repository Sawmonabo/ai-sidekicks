//! A connection to the daemon's named pipe on Windows: opened at identification level, so the
//! server can learn who connects but never act as them, waited for while every instance of the
//! pipe is busy, and checked to be served by a process of this account before the caller writes a
//! byte, so a process of another account holding the name cannot pose as the daemon.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt as _;
use std::os::windows::io::{AsRawHandle as _, OwnedHandle};
use std::path::Path;
use std::time::Duration;

use interprocess::local_socket::tokio::Stream;
use interprocess::os::windows::named_pipe::local_socket::tokio::Stream as NamedPipeStream;
use windows_sys::Win32::Foundation::{ERROR_PIPE_BUSY, FALSE};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OVERLAPPED, SECURITY_IDENTIFICATION};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;

use crate::windows::process_user::ProcessUser;

// The wait between two opens of a pipe whose every instance is busy, as tokio's own client waits.
const PIPE_BUSY_WAIT: Duration = Duration::from_millis(50);

// The opens a busy pipe gets before its connect fails with `ERROR_PIPE_BUSY`: two seconds.
const PIPE_BUSY_ATTEMPTS: u32 = 40;

/// Connects to the named pipe at `socket_path`: opened for overlapped reads and writes at
/// identification level, opened again every 50 ms for two seconds while every instance is busy,
/// and refused unless a process of this account serves it. Fails with the system's error,
/// `NotFound` when no server holds the name, and `PermissionDenied` when another account's process
/// serves it.
pub async fn connect_socket(socket_path: &Path) -> io::Result<Stream> {
    let pipe = OwnedHandle::from(open_pipe(socket_path).await?);
    check_pipe_server(&pipe)?;
    Ok(NamedPipeStream::try_from(pipe)
        .map_err(io::Error::from)?
        .into())
}

// Opens the pipe, again after each wait while every instance is busy.
async fn open_pipe(socket_path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OVERLAPPED)
        .security_qos_flags(SECURITY_IDENTIFICATION);
    let mut attempt = 1;
    loop {
        match options.open(socket_path) {
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY.cast_signed())
                    && attempt < PIPE_BUSY_ATTEMPTS =>
            {
                attempt += 1;
                tokio::time::sleep(PIPE_BUSY_WAIT).await;
            }
            opened => return opened,
        }
    }
}

// Refuses the pipe unless the process serving it runs as this process's user.
fn check_pipe_server(pipe: &OwnedHandle) -> io::Result<()> {
    let mut server_id = 0_u32;
    // SAFETY: the handle is an open pipe, and the call writes the server's id into the local.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &raw mut server_id) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    let server_user = ProcessUser::of_process_id(server_id)?;
    if !ProcessUser::of_this_process()?.has_sid(server_user.sid()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the named pipe is served by another account's process",
        ));
    }
    Ok(())
}
