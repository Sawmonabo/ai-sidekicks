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
    connect_pipe_served_by(socket_path, &ProcessUser::of_this_process()?).await
}

// Connects to the pipe at `socket_path`, refused before the stream exists unless a process
// running as `user` serves it.
async fn connect_pipe_served_by(socket_path: &Path, user: &ProcessUser) -> io::Result<Stream> {
    let pipe = OwnedHandle::from(open_pipe(socket_path).await?);
    check_pipe_server(&pipe, user)?;
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

// Refuses the pipe unless the process serving it runs as `user`.
fn check_pipe_server(pipe: &OwnedHandle, user: &ProcessUser) -> io::Result<()> {
    let mut server_id = 0_u32;
    // SAFETY: the handle is an open pipe, and the call writes the server's id into the local.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &raw mut server_id) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    let server_user = ProcessUser::of_process_id(server_id)?;
    if !user.has_sid(server_user.sid()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the named pipe is served by another account's process",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::path::Path;

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows_sys::Win32::Security::WinLocalSystemSid;

    use super::connect_pipe_served_by;
    use crate::windows::process_user::ProcessUser;

    // A stand-in daemon of this account serves the pipe; a client that expects another account's
    // server is refused before the stream exists, so the stand-in reads nothing, and a client that
    // expects this account's carries its bytes.
    #[tokio::test]
    async fn the_owner_check_refuses_another_account_s_server_before_a_byte() {
        let name = format!(
            r"\\.\pipe\ai-sidekicks-test-owner-check-{}",
            std::process::id()
        );
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .expect("the stand-in serves the pipe");
        let other_account = ProcessUser::of_well_known_account(WinLocalSystemSid);

        let (connected, refused) = tokio::join!(
            server.connect(),
            connect_pipe_served_by(Path::new(&name), &other_account)
        );
        connected.expect("the refused client reached the stand-in");
        let refusal = refused.expect_err("another account's server is refused");
        let mut received = Vec::new();
        server
            .read_to_end(&mut received)
            .await
            .expect("the stand-in reads to the end");

        assert_eq!(refusal.kind(), ErrorKind::PermissionDenied, "{refusal:?}");
        assert!(received.is_empty(), "the refused client wrote {received:?}");

        server
            .disconnect()
            .expect("the stand-in lets the refused client go");
        let this_account = ProcessUser::of_this_process().expect("this account reads");
        let (connected, admitted) = tokio::join!(
            server.connect(),
            connect_pipe_served_by(Path::new(&name), &this_account)
        );
        connected.expect("the admitted client reached the stand-in");
        let mut client = admitted.expect("this account's server is admitted");
        client.write_all(b"token").await.expect("the client writes");
        let mut read = [0_u8; 5];
        server
            .read_exact(&mut read)
            .await
            .expect("the stand-in reads");

        assert_eq!(&read, b"token");
    }
}
