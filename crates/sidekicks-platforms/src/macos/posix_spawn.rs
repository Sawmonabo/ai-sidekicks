//! What macOS's `posix_spawn` takes, owned: its attributes and its file actions, each destroyed
//! when dropped; the start of a child leading a session of its own through it, which runs no fork
//! handler in the child, and that child's reap, since no runtime reaps a child it did not spawn.

use std::ffi::{CString, OsStr, OsString, c_int, c_short};
use std::io;
use std::os::fd::{AsRawFd as _, BorrowedFd};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::process::ExitStatus;

use nix::errno::Errno;
use nix::sys::signal::{SigSet, Signal, kill};
use nix::unistd::Pid;

use crate::c_string_array::null_terminated_pointers;
use crate::macos::pinned_process::PinnedProcess;
use crate::posix::null_device::NULL_DEVICE_PATH;
use crate::posix::process::id::system_process_id;

/// `sys/spawn.h`'s flag that makes the child lead a session of its own, which the `libc` crate
/// does not list.
const POSIX_SPAWN_SETSID: c_int = 0x0400;

/// A spawn's attributes, destroyed when this drops. macOS's attributes object is a pointer to
/// memory the system owns, so moving this moves only the pointer.
pub(crate) struct SpawnAttributes(libc::posix_spawnattr_t);

impl SpawnAttributes {
    /// Fresh attributes, every flag clear. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        // SAFETY: `attributes` is a live, writable attributes object for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawnattr_init(&raw mut attributes) })?;
        Ok(Self(attributes))
    }

    /// Sets the spawn's flags to `flags`, replacing any set before. Fails with the error code the
    /// system answers.
    pub(crate) fn set_flags(&mut self, flags: c_int) -> io::Result<()> {
        let flags = c_short::try_from(flags).expect("the spawn flags fit the flags' short");
        // SAFETY: the attributes were set up by `new` and live as long as `self`.
        check_spawn_status(unsafe { libc::posix_spawnattr_setflags(self.as_mut_ptr(), flags) })
    }

    /// The attributes, for a call that sets one of them.
    pub(crate) fn as_mut_ptr(&mut self) -> *mut libc::posix_spawnattr_t {
        &raw mut self.0
    }

    /// The attributes, for the spawn.
    pub(crate) fn as_ptr(&self) -> *const libc::posix_spawnattr_t {
        &raw const self.0
    }
}

impl Drop for SpawnAttributes {
    fn drop(&mut self) {
        // SAFETY: the attributes were set up by `new` and are destroyed only here. The call frees
        // memory and cannot fail on a set-up object.
        unsafe { libc::posix_spawnattr_destroy(self.as_mut_ptr()) };
    }
}

/// A spawn's file actions, run in order in the child before its program, destroyed when this
/// drops; a pointer to memory the system owns, as [`SpawnAttributes`] is.
pub(crate) struct SpawnFileActions(libc::posix_spawn_file_actions_t);

impl SpawnFileActions {
    /// An empty list of file actions. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
        // SAFETY: `actions` is a live, writable file-actions object for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawn_file_actions_init(&raw mut actions) })?;
        Ok(Self(actions))
    }

    /// The file actions, for a call that adds one.
    pub(crate) fn as_mut_ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
        &raw mut self.0
    }

    /// The file actions, for the spawn.
    pub(crate) fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
        &raw const self.0
    }
}

impl Drop for SpawnFileActions {
    fn drop(&mut self) {
        // SAFETY: the file actions were set up by `new` and are destroyed only here. The call frees
        // memory and cannot fail on a set-up object.
        unsafe { libc::posix_spawn_file_actions_destroy(self.as_mut_ptr()) };
    }
}

/// `Ok` for a spawn call's status of 0, else the error its code names.
pub(crate) fn check_spawn_status(status: c_int) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status))
    }
}

/// Where one standard stream of a child [`spawn_session_leader`] starts reads or writes.
pub(crate) enum SpawnStream<'a> {
    /// The null device, read-only for standard input and write-only for the outputs.
    NullDevice,
    /// A descriptor of this process, duplicated onto the stream.
    Descriptor(BorrowedFd<'a>),
}

/// What [`spawn_session_leader`] starts.
pub(crate) struct SessionLeaderSpawn<'a> {
    /// The program, an absolute path.
    pub(crate) program: &'a Path,
    /// The first word of its command line, the name it reads as its own.
    pub(crate) argument_zero: &'a OsStr,
    /// The words after the first.
    pub(crate) arguments: &'a [String],
    /// Its whole environment, each entry `NAME=VALUE`.
    pub(crate) environment: Vec<OsString>,
    /// The folder it starts in.
    pub(crate) working_folder: &'a Path,
    /// Its standard input, output and error, in that order.
    pub(crate) streams: [SpawnStream<'a>; 3],
}

/// Starts `spawn` with `posix_spawn` by its program's path: in a session and group of its own,
/// `SIGPIPE` back at its default as std sets it for a `Command` child, the spawning thread's signal
/// mask kept as std keeps it, only its three standard streams open, in its folder. Answers the
/// child's id; the caller reaps it. Fails with `InvalidInput` for a NUL in the program, a word, the
/// environment or the folder, else with the error code the system answers, a program that cannot
/// run among them.
pub(crate) fn spawn_session_leader(spawn: &SessionLeaderSpawn<'_>) -> io::Result<u32> {
    let program = c_string(spawn.program.as_os_str())?;
    let arguments = std::iter::once(c_string(spawn.argument_zero))
        .chain(
            spawn
                .arguments
                .iter()
                .map(|argument| c_string(OsStr::new(argument))),
        )
        .collect::<io::Result<Vec<_>>>()?;
    let environment = spawn
        .environment
        .iter()
        .map(|entry| c_string(entry))
        .collect::<io::Result<Vec<_>>>()?;
    let folder = c_string(spawn.working_folder.as_os_str())?;
    let null_device = c_string(OsStr::new(NULL_DEVICE_PATH))?;

    let mut file_actions = SpawnFileActions::new()?;
    for (stream, descriptor) in
        spawn
            .streams
            .iter()
            .zip([libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO])
    {
        match stream {
            SpawnStream::NullDevice => {
                let access = if descriptor == libc::STDIN_FILENO {
                    libc::O_RDONLY
                } else {
                    libc::O_WRONLY
                };
                // SAFETY: the file actions were set up above, and the path is a C string that
                // outlives the spawn, which reads it.
                check_spawn_status(unsafe {
                    libc::posix_spawn_file_actions_addopen(
                        file_actions.as_mut_ptr(),
                        descriptor,
                        null_device.as_ptr(),
                        access,
                        0,
                    )
                })?;
            }
            SpawnStream::Descriptor(source) => {
                // SAFETY: the file actions were set up above, and the source descriptor is
                // borrowed for `spawn`'s life, which outlives the spawn.
                check_spawn_status(unsafe {
                    libc::posix_spawn_file_actions_adddup2(
                        file_actions.as_mut_ptr(),
                        source.as_raw_fd(),
                        descriptor,
                    )
                })?;
            }
        }
    }
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

    let argument_pointers = null_terminated_pointers(&arguments);
    let environment_pointers = null_terminated_pointers(&environment);
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

/// Reaps the child `id` this process spawned, waiting for its exit, and answers how it ended.
/// Blocking, so it runs in `spawn_blocking`, or once the child has ended. Fails with
/// `InvalidInput` for an id of 0 or past `i32::MAX`, else with the system's error from the wait.
pub(crate) fn reap_spawned_child(id: u32) -> io::Result<ExitStatus> {
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

/// Waits with no thread for the end of `process`, a child this process spawned, then reaps it on
/// a blocking thread, where the reap answers at once, and answers how it ended. Must be called
/// within the runtime. Fails with the system's error from the wait or the reap.
pub(crate) async fn reap_ended_child(process: &PinnedProcess) -> io::Result<ExitStatus> {
    process.wait_for_end().await?;
    let id = process.id();
    tokio::task::spawn_blocking(move || reap_spawned_child(id))
        .await
        .map_err(io::Error::other)?
}

/// Kills the child `id` this process spawned, it alone, and reaps it, so nothing runs on that no
/// one answers for and nothing is left a zombie; a child already ended is reaped all the same.
/// Blocking only until the killed child's exit. Fails with the system's error from the kill, which
/// leaves the child unreaped rather than wait on one still running, or the reap.
pub(crate) fn end_spawned_child(id: u32) -> io::Result<()> {
    // Unreaped, the child keeps its id, so the kill by id reaches no other process.
    let pid = Pid::from_raw(system_process_id(id)?.get());
    match kill(pid, Signal::SIGKILL) {
        // A child that already ended is still unreaped, so the reap below finds it.
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(errno) => return Err(io::Error::from(errno)),
    }
    reap_spawned_child(id).map(drop)
}

/// `text` as a C string; `InvalidInput` when it holds a NUL.
fn c_string(text: &OsStr) -> io::Result<CString> {
    CString::new(text.as_bytes()).map_err(io::Error::from)
}
