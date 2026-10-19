//! The daemon's word that it started a terminal's `shell` mode, and the shell's launch with it, on
//! Windows: the `ConPTY` start hands the mode no handle, so the daemon makes a named pipe of a
//! fresh random name before the spawn and puts the name in the mode's environment; the daemon
//! writes the launch only to the client whose process is the one it started, and the mode reads it
//! only from a server whose process is the daemon its argument names. No other process can take the
//! name first, the pipe takes one client, only this user may open it, and no remote client is let
//! in.

use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::OpenOptionsExt as _;
use std::os::windows::io::AsRawHandle as _;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::FALSE;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};

use crate::shell_start::{SHELL_START_CONFIRMATION, ShellLaunch};
use crate::windows::process_user::UserOnlyDescriptor;

// The start of every shell start's pipe name; the daemon's process id and random bytes follow.
const PIPE_NAME_PREFIX: &str = r"\\.\pipe\ai-sidekicks-shell-";

// The random bytes in a pipe name.
const PIPE_NAME_RANDOM_BYTES: usize = 16;

/// The daemon's side of one shell start's confirmation: the named pipe the `shell` mode connects
/// to, and once the start is known, the process it must connect from.
pub struct ShellStartConfirmation {
    /// The pipe's server end, until the launch's writer takes it.
    pipe: Option<NamedPipeServer>,
    /// The pipe's name, which the mode's environment carries.
    name: String,
    /// The process the daemon started, the only client the launch goes to.
    shell_process_id: Option<u32>,
}

impl ShellStartConfirmation {
    /// Makes the pipe for the next shell's start, as its first and only instance, open to this user
    /// alone and closed to remote clients. Runs inside the runtime, on the daemon's spawner thread.
    /// Fails with the system's error, `PermissionDenied` when a pipe of the drawn name already
    /// exists.
    pub fn new() -> io::Result<Self> {
        let mut random = [0_u8; PIPE_NAME_RANDOM_BYTES];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let mut name = format!("{PIPE_NAME_PREFIX}{}-", std::process::id());
        for byte in random {
            write!(name, "{byte:02x}").expect("a string takes any text written to it");
        }
        let descriptor = UserOnlyDescriptor::new()?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
                .expect("the attributes' size fits a u32"),
            lpSecurityDescriptor: descriptor.as_raw(),
            bInheritHandle: FALSE,
        };
        // SAFETY: the attributes and the descriptor they point to live across the call.
        let pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .max_instances(1)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, (&raw mut attributes).cast())
        }?;
        Ok(Self {
            pipe: Some(pipe),
            name,
            shell_process_id: None,
        })
    }

    /// The variable and value the `shell` mode's environment carries so the mode finds the pipe;
    /// `None` once the launch's writer has taken the pipe.
    pub fn environment_entry(&self) -> Option<(String, String)> {
        self.pipe
            .as_ref()
            .map(|_| (SHELL_START_CONFIRMATION.to_owned(), self.name.clone()))
    }

    /// Records that the daemon started process `shell_process_id`, the one client the launch is
    /// written to. Never fails.
    pub fn confirm(&mut self, shell_process_id: u32) -> io::Result<()> {
        self.shell_process_id = Some(shell_process_id);
        Ok(())
    }

    /// The writer of the shell's launch, holding the pipe and the process confirmed to connect to
    /// it. Fails with `InvalidInput` before a confirmation or once a writer took the pipe.
    pub fn launch_writer(&mut self) -> io::Result<ShellLaunchWriter> {
        match (self.pipe.take(), self.shell_process_id) {
            (Some(pipe), Some(shell_process_id)) => Ok(ShellLaunchWriter {
                pipe,
                shell_process_id,
            }),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the shell's start is not confirmed, or its launch's writer was taken",
            )),
        }
    }
}

/// The daemon's writer of one shell's launch frame, after its start's confirmation.
pub struct ShellLaunchWriter {
    /// The pipe's server end.
    pipe: NamedPipeServer,
    /// The only process the launch is written to.
    shell_process_id: u32,
}

impl ShellLaunchWriter {
    /// Waits for the `shell` mode to connect, refuses a client that is not the process the daemon
    /// started, writes the launch frame `frame`, then waits until the mode closes its end, so the
    /// frame is read before the pipe goes. Fails with `PermissionDenied` for another client, and
    /// with the system's error otherwise.
    pub async fn write(mut self, frame: &[u8]) -> io::Result<()> {
        self.pipe.connect().await?;
        let mut client_id = 0_u32;
        // SAFETY: the handle is the connected pipe's server end, and the call writes the client's
        // id into the local.
        let status =
            unsafe { GetNamedPipeClientProcessId(self.pipe.as_raw_handle(), &raw mut client_id) };
        if status == FALSE {
            return Err(io::Error::last_os_error());
        }
        if client_id != self.shell_process_id {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "process {client_id}, not the shell's {}, connected to its start's pipe",
                    self.shell_process_id
                ),
            ));
        }
        self.pipe.write_all(frame).await?;
        let mut closed = [0_u8; 1];
        match self.pipe.read(&mut closed).await {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// Reads the shell's launch from the pipe the mode's environment names, served by the daemon
/// `daemon_pid`. Opened at identification level, so the server can never act as the mode. Fails
/// with `NotFound` when no pipe is named, `PermissionDenied` when another process serves it,
/// `InvalidData` for a malformed frame, `UnexpectedEof` when the pipe closed early, and the
/// system's error otherwise.
pub(crate) fn receive_launch(daemon_pid: u32) -> io::Result<ShellLaunch> {
    let name = std::env::var(SHELL_START_CONFIRMATION)
        .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error))?;
    let mut pipe = OpenOptions::new()
        .read(true)
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(&name)?;
    let mut server_id = 0_u32;
    // SAFETY: the handle is the open pipe's client end, and the call writes the server's id into
    // the local.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &raw mut server_id) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    if server_id != daemon_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("process {server_id}, not the daemon {daemon_pid}, serves the start's pipe"),
        ));
    }
    ShellLaunch::read_from(&mut pipe)
}
