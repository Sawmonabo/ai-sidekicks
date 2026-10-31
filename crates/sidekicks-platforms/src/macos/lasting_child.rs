//! A lasting child's start on macOS, through `posix_spawn` in a session of its own.

use std::ffi::OsString;
use std::io;
use std::os::fd::AsFd as _;

use nix::sys::signal::Signal;

use crate::lasting_child::LastingCommand;
use crate::posix::spawn::{SessionLeaderSpawn, SpawnStream, spawn_session_leader};

/// Starts `command` as [`spawn_session_leader`] starts a child, named by its program's path, its
/// standard input and output the null device and its error output `error_output`, with only the
/// environment it names. Answers the child's id; the caller reaps it. Fails as
/// [`spawn_session_leader`] fails.
pub(crate) fn spawn_lasting_child_process(command: &LastingCommand) -> io::Result<u32> {
    spawn_session_leader(&SessionLeaderSpawn {
        program: &command.program,
        argument_zero: command.program.as_os_str(),
        arguments: &command.arguments,
        environment: command
            .environment
            .iter()
            .map(|(name, value)| OsString::from(format!("{name}={value}")))
            .collect(),
        working_folder: Some(&command.working_folder),
        streams: [
            SpawnStream::NullDevice,
            SpawnStream::NullDevice,
            SpawnStream::Descriptor(command.error_output.as_fd()),
        ],
        inherited: None,
        default_signals: &[Signal::SIGPIPE],
    })
}
