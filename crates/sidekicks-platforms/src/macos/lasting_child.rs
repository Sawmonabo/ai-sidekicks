//! A lasting child's start on macOS, through `posix_spawn` in a session of its own, which runs no
//! fork handler in the child, and its reap, since no runtime reaps a child it did not spawn.

use std::ffi::{CString, OsStr, c_int};
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::process::ExitStatusExt as _;
use std::process::ExitStatus;

use nix::errno::Errno;
use nix::sys::signal::{SigSet, Signal, kill};
use nix::unistd::Pid;

use crate::lasting_child::LastingCommand;
use crate::macos::posix_spawn::{
    SpawnAttributes, SpawnFileActions, check_spawn_status, null_terminated,
};
use crate::posix::null_device::NULL_DEVICE_PATH;
use crate::posix::process::id::system_process_id;

/// `sys/spawn.h`'s flag that makes the child lead a session of its own, which the `libc` crate
/// does not list.
const POSIX_SPAWN_SETSID: c_int = 0x0400;

/// Starts `command` with `posix_spawn` by its program's path: in a session and group of its own,
/// `SIGPIPE` back at its default as std sets it for a `Command` child, the spawning thread's signal
/// mask kept as std keeps it, only standard input and output (both the null device) and error
/// output (`error_output`) open, in `working_folder`. Answers the child's id; the caller reaps it.
/// Fails with `InvalidInput` for a NUL in the program, an argument, the environment or the folder,
/// else with the error code the system answers, a program that cannot run among them.
pub(crate) fn spawn_lasting_child_process(command: &LastingCommand) -> io::Result<u32> {
    let program = c_string(command.program.as_os_str())?;
    let arguments = std::iter::once(Ok(program.clone()))
        .chain(
            command
                .arguments
                .iter()
                .map(|argument| c_string(OsStr::new(argument))),
        )
        .collect::<io::Result<Vec<_>>>()?;
    let environment = command
        .environment
        .iter()
        .map(|(name, value)| c_string(OsStr::new(&format!("{name}={value}"))))
        .collect::<io::Result<Vec<_>>>()?;
    let folder = c_string(command.working_folder.as_os_str())?;
    let null_device = c_string(OsStr::new(NULL_DEVICE_PATH))?;

    let mut file_actions = SpawnFileActions::new()?;
    // SAFETY: the file actions were set up above, and the path is a C string that outlives the
    // spawn, which reads it.
    check_spawn_status(unsafe {
        libc::posix_spawn_file_actions_addopen(
            file_actions.as_mut_ptr(),
            libc::STDIN_FILENO,
            null_device.as_ptr(),
            libc::O_RDONLY,
            0,
        )
    })?;
    // SAFETY: as above.
    check_spawn_status(unsafe {
        libc::posix_spawn_file_actions_addopen(
            file_actions.as_mut_ptr(),
            libc::STDOUT_FILENO,
            null_device.as_ptr(),
            libc::O_WRONLY,
            0,
        )
    })?;
    // SAFETY: the file actions were set up above, and the error output's descriptor stays open
    // until the spawn, which `command`'s borrow outlives.
    check_spawn_status(unsafe {
        libc::posix_spawn_file_actions_adddup2(
            file_actions.as_mut_ptr(),
            command.error_output.as_raw_fd(),
            libc::STDERR_FILENO,
        )
    })?;
    // SAFETY: the file actions were set up above, and the folder is a C string that outlives the
    // spawn.
    check_spawn_status(unsafe {
        libc::posix_spawn_file_actions_addchdir_np(file_actions.as_mut_ptr(), folder.as_ptr())
    })?;

    let mut attributes = SpawnAttributes::new()?;
    let mut default_signals = SigSet::empty();
    default_signals.add(Signal::SIGPIPE);
    // SAFETY: the attributes were set up above, and the call copies the set.
    check_spawn_status(unsafe {
        libc::posix_spawnattr_setsigdefault(attributes.as_mut_ptr(), default_signals.as_ref())
    })?;
    attributes.set_flags(
        POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_CLOEXEC_DEFAULT,
    )?;

    let argument_pointers = null_terminated(&arguments);
    let environment_pointers = null_terminated(&environment);
    let mut pid: libc::pid_t = 0;
    // SAFETY: the path and both arrays are NUL- and NULL-terminated and outlive the call, and the
    // file actions and the attributes were set up above. `posix_spawn`, never `posix_spawnp`,
    // which runs a file the kernel refuses through `/bin/sh`.
    check_spawn_status(unsafe {
        libc::posix_spawn(
            &raw mut pid,
            program.as_ptr(),
            file_actions.as_ptr(),
            attributes.as_ptr(),
            argument_pointers.as_ptr(),
            environment_pointers.as_ptr(),
        )
    })?;
    Ok(u32::try_from(pid).expect("a started process's id is positive"))
}

/// Reaps the lasting child `id` this process spawned, waiting for its exit, and answers how it
/// ended. Blocking, so it runs in `spawn_blocking`, or once the child has ended. Fails with
/// `InvalidInput` for an id of 0 or past `i32::MAX`, else with the system's error from the wait.
pub(crate) fn reap_lasting_child(id: u32) -> io::Result<ExitStatus> {
    let pid = system_process_id(id)?.get();
    let mut status: c_int = 0;
    loop {
        // SAFETY: `status` is a live, writable integer, and `pid` names this process's own child.
        if unsafe { libc::waitpid(pid, &raw mut status, 0) } == pid {
            return Ok(ExitStatus::from_raw(status));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error);
        }
    }
}

/// Kills the lasting child `id` this process spawned and reaps it, for a start that cannot answer
/// it, so no unrecorded child runs on and none is left a zombie; a child already ended is reaped
/// all the same. Blocking only until the killed child's exit. Fails with the system's error from
/// the kill, which leaves the child unreaped rather than wait on one still running, or the reap.
pub(crate) fn end_unrecorded_lasting_child(id: u32) -> io::Result<()> {
    let pid = Pid::from_raw(system_process_id(id)?.get());
    match kill(pid, Signal::SIGKILL) {
        // A child that already ended is still unreaped, so the reap below finds it.
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(errno) => return Err(io::Error::from(errno)),
    }
    reap_lasting_child(id).map(drop)
}

/// `text` as a C string; `InvalidInput` when it holds a NUL.
fn c_string(text: &OsStr) -> io::Result<CString> {
    CString::new(text.as_bytes()).map_err(io::Error::from)
}
