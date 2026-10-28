//! What `posix_spawn` takes on macOS and Linux, owned: its attributes and its file actions, each
//! destroyed when dropped; the start of a child leading a session of its own through it, which runs
//! no fork handler in the child, and that child's reap, since no runtime reaps a child it did not
//! spawn.

use std::ffi::{OsStr, OsString, c_int, c_short};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd as _, BorrowedFd, RawFd};
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::process::ExitStatus;

use nix::sys::signal::{SigSet, Signal};

use crate::c_string_array::null_terminated_pointers;
use crate::posix::c_string::c_string;
#[cfg(target_os = "macos")]
use crate::posix::null_device::NULL_DEVICE_PATH;
use crate::posix::process::id::system_process_id;

/// `sys/spawn.h`'s flag that makes the child lead a session of its own, which the `libc` crate
/// does not list for macOS.
#[cfg(target_os = "macos")]
const POSIX_SPAWN_SETSID: c_int = 0x0400;

/// glibc's flag that makes the child lead a session of its own, run before the file actions.
#[cfg(target_os = "linux")]
const POSIX_SPAWN_SETSID: c_int = libc::POSIX_SPAWN_SETSID as c_int;

/// The descriptor a Linux child holds the inherited descriptor on: the first after the standard
/// streams, so every descriptor above it closes in the spawn.
#[cfg(target_os = "linux")]
const INHERITED_DESCRIPTOR: RawFd = 3;

// The call that adds a folder change to a spawn's file actions.
#[cfg(target_os = "macos")]
type AddChdirCall =
    unsafe extern "C" fn(*mut libc::posix_spawn_file_actions_t, *const std::ffi::c_char) -> c_int;

/// macOS's call that adds a folder change to a spawn's file actions, found by name at run time the
/// first time: `posix_spawn_file_actions_addchdir`, which macOS 26 is the first to export, else the
/// `_np` name every macOS since 10.15 exports, so the program loads on every macOS the product
/// runs on. `Unsupported` on a macOS with neither.
#[cfg(target_os = "macos")]
fn add_chdir_call() -> io::Result<AddChdirCall> {
    use std::sync::OnceLock;

    use crate::macos::loaded_images::look_up_symbol;

    static CALL: OnceLock<Option<AddChdirCall>> = OnceLock::new();
    CALL.get_or_init(|| {
        let symbol = look_up_symbol(c"posix_spawn_file_actions_addchdir")
            .or_else(|| look_up_symbol(c"posix_spawn_file_actions_addchdir_np"))?;
        // SAFETY: either symbol is libSystem's function of exactly this signature.
        Some(unsafe { std::mem::transmute::<*mut libc::c_void, AddChdirCall>(symbol) })
    })
    .ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "this macOS has no call adding a folder change to a spawn",
        )
    })
}

/// A spawn's attributes, destroyed when this drops. Nothing the system keeps points at the value,
/// so it moves freely: macOS's is a pointer to memory the system owns, glibc's a plain struct.
pub(crate) struct SpawnAttributes(libc::posix_spawnattr_t);

impl SpawnAttributes {
    /// Fresh attributes, every flag clear. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut attributes = MaybeUninit::<libc::posix_spawnattr_t>::uninit();
        // SAFETY: `attributes` is live, writable memory for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawnattr_init(attributes.as_mut_ptr()) })?;
        // SAFETY: the call succeeded, so it set the attributes up.
        Ok(Self(unsafe { attributes.assume_init() }))
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
/// drops; free to move, as [`SpawnAttributes`] is.
pub(crate) struct SpawnFileActions(libc::posix_spawn_file_actions_t);

impl SpawnFileActions {
    /// An empty list of file actions. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut actions = MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
        // SAFETY: `actions` is live, writable memory for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawn_file_actions_init(actions.as_mut_ptr()) })?;
        // SAFETY: the call succeeded, so it set the file actions up.
        Ok(Self(unsafe { actions.assume_init() }))
    }

    /// The file actions, for a call that adds one.
    pub(crate) fn as_mut_ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
        &raw mut self.0
    }

    /// The file actions, for the spawn.
    pub(crate) fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
        &raw const self.0
    }

    /// Adds the duplication of `source` onto `target` in the child. Fails with the error code the
    /// system answers, `EBADF` for a descriptor past the system's bound.
    fn add_duplicate(&mut self, source: RawFd, target: RawFd) -> io::Result<()> {
        // SAFETY: the file actions were set up by `new`; the call copies both numbers.
        check_spawn_status(unsafe {
            libc::posix_spawn_file_actions_adddup2(self.as_mut_ptr(), source, target)
        })
    }

    /// Adds the change into `folder` in the child, a failure of which fails the spawn. Fails with
    /// the error code the system answers, and on macOS with `Unsupported` without the call.
    fn add_folder_change(&mut self, folder: &std::ffi::CStr) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        let add_chdir = add_chdir_call()?;
        #[cfg(target_os = "linux")]
        let add_chdir = libc::posix_spawn_file_actions_addchdir_np;
        // SAFETY: the file actions were set up by `new`, and the call copies the folder's path.
        check_spawn_status(unsafe { add_chdir(self.as_mut_ptr(), folder.as_ptr()) })
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
    /// The null device, read-only for standard input and write-only for the outputs; only macOS's
    /// lasting and session children take it.
    #[cfg(target_os = "macos")]
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
    /// The folder it starts in; `None` keeps this process's.
    pub(crate) working_folder: Option<&'a Path>,
    /// Its standard input, output and error, in that order.
    pub(crate) streams: [SpawnStream<'a>; 3],
    /// One more descriptor it keeps open, at the number [`inherited_descriptor_in_child`] gives.
    pub(crate) inherited: Option<BorrowedFd<'a>>,
    /// The signals set back to their default action in it, which matters for one this process
    /// ignores, since a handler never survives the exec.
    pub(crate) default_signals: &'a [Signal],
}

/// The number a child [`spawn_session_leader`] starts holds `descriptor` at when it inherits it:
/// the same on macOS, whose spawn keeps a descriptor its file actions name.
#[cfg(target_os = "macos")]
pub(crate) fn inherited_descriptor_in_child(descriptor: BorrowedFd<'_>) -> RawFd {
    descriptor.as_raw_fd()
}

/// The number a child [`spawn_session_leader`] starts holds `descriptor` at when it inherits it:
/// `INHERITED_DESCRIPTOR` on Linux, whose spawn closes every descriptor above that one.
#[cfg(target_os = "linux")]
pub(crate) fn inherited_descriptor_in_child(_descriptor: BorrowedFd<'_>) -> RawFd {
    INHERITED_DESCRIPTOR
}

/// Starts `spawn` with `posix_spawn` by its program's path: in a session and group of its own, its
/// default signals back at their default, the spawning thread's signal mask kept as std keeps it,
/// only its three standard streams and its inherited descriptor open, in its folder. Answers the
/// child's id; the caller reaps it. Fails with `InvalidInput` for a NUL in the program, a word, the
/// environment or the folder, else with the error code the system answers, a program that cannot
/// run and a folder that cannot be entered among them.
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
    let folder = spawn
        .working_folder
        .map(|folder| c_string(folder.as_os_str()))
        .transpose()?;

    let mut file_actions = SpawnFileActions::new()?;
    for (stream, descriptor) in
        spawn
            .streams
            .iter()
            .zip([libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO])
    {
        match stream {
            #[cfg(target_os = "macos")]
            SpawnStream::NullDevice => {
                let null_device = c_string(OsStr::new(NULL_DEVICE_PATH))?;
                let access = if descriptor == libc::STDIN_FILENO {
                    libc::O_RDONLY
                } else {
                    libc::O_WRONLY
                };
                // SAFETY: the file actions were set up above, and the call copies the path.
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
                file_actions.add_duplicate(source.as_raw_fd(), descriptor)?;
            }
        }
    }
    // After the streams, so a source numbered 0 to 2 is read before it is replaced. macOS keeps a
    // descriptor a duplication names under `POSIX_SPAWN_CLOEXEC_DEFAULT`, and a duplication clears
    // close-on-exec on the copy.
    if let Some(inherited) = spawn.inherited {
        file_actions.add_duplicate(
            inherited.as_raw_fd(),
            inherited_descriptor_in_child(inherited),
        )?;
    }
    // Linux has no `POSIX_SPAWN_CLOEXEC_DEFAULT`, so the spawn closes every descriptor above the
    // ones it hands on; glibc 2.34 is the first with the call.
    #[cfg(target_os = "linux")]
    {
        let first_closed = if spawn.inherited.is_some() {
            INHERITED_DESCRIPTOR + 1
        } else {
            INHERITED_DESCRIPTOR
        };
        // SAFETY: the file actions were set up above; the call copies the number.
        check_spawn_status(unsafe {
            libc::posix_spawn_file_actions_addclosefrom_np(file_actions.as_mut_ptr(), first_closed)
        })?;
    }
    if let Some(folder) = &folder {
        file_actions.add_folder_change(folder)?;
    }

    let mut attributes = SpawnAttributes::new()?;
    let mut default_signals = SigSet::empty();
    for signal in spawn.default_signals {
        default_signals.add(*signal);
    }
    // SAFETY: the attributes were set up above, and the call copies the set.
    check_spawn_status(unsafe {
        libc::posix_spawnattr_setsigdefault(attributes.as_mut_ptr(), default_signals.as_ref())
    })?;
    #[cfg(target_os = "macos")]
    let flags =
        POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
    #[cfg(target_os = "linux")]
    let flags = POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF;
    attributes.set_flags(flags)?;

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

/// The daemon's own environment as `NAME=VALUE` entries, each of `added` set over it.
pub(crate) fn inherited_environment(added: &[(String, String)]) -> Vec<OsString> {
    let inherited = std::env::vars_os().filter(|(name, _)| {
        !added
            .iter()
            .any(|(added_name, _)| OsStr::new(added_name) == name)
    });
    let added = added
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
    inherited
        .chain(added)
        .map(|(name, value)| {
            let mut entry = OsString::with_capacity(name.len() + value.len() + 1);
            entry.push(name);
            entry.push("=");
            entry.push(value);
            entry
        })
        .collect()
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

/// Reaps the child `id` this process spawned when it has exited, never waiting, and answers how it
/// ended; `None` while it runs or before the system reports its exit to a wait. Fails with
/// `InvalidInput` for an id of 0 or past `i32::MAX`, else with the system's error from the wait.
pub(crate) fn reap_exited_child(id: u32) -> io::Result<Option<ExitStatus>> {
    let pid = system_process_id(id)?.get();
    let mut status: c_int = 0;
    loop {
        // SAFETY: `status` is a live, writable integer, and `pid` names this process's own child.
        match unsafe { libc::waitpid(pid, &raw mut status, libc::WNOHANG) } {
            0 => return Ok(None),
            reaped if reaped == pid => return Ok(Some(ExitStatus::from_raw(status))),
            _ => {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINTR) {
                    return Err(error);
                }
            }
        }
    }
}

/// Waits with no thread for the end of `process`, a child this process spawned, then reaps it on
/// a blocking thread, where the reap answers at once, and answers how it ended; where the wait for
/// its end cannot be set up, the blocking reap waits for the exit itself, so no child is left a
/// zombie, at the cost of one blocking thread held until the child exits, which the daemon's stop
/// then waits on up to its drain bound. Must be called within the runtime. Fails with the system's
/// error from the reap.
#[cfg(target_os = "macos")]
pub(crate) async fn reap_ended_child(
    process: &crate::macos::pinned_process::PinnedProcess,
) -> io::Result<ExitStatus> {
    let id = process.id();
    if let Err(error) = process.wait_for_end().await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a spawned child's end could not be watched, so its reap waits for it"
        );
    }
    tokio::task::spawn_blocking(move || reap_spawned_child(id))
        .await
        .map_err(io::Error::other)?
}

/// Kills the child `id` this process spawned, it alone, on this thread, and reaps it, so nothing
/// runs on that no one answers for; a child already ended is reaped all the same. The reap, which
/// waits for the killed child's exit, runs on this thread with no runtime current, else on the
/// runtime's blocking pool while the runtime runs, logging its failure; a drop as the runtime ends
/// can leave the child unreaped until this process exits. Fails with the system's error from the
/// kill, which leaves the child unreaped rather than wait on one still running, or from a reap on
/// this thread.
#[cfg(target_os = "macos")]
pub(crate) fn end_spawned_child(id: u32) -> io::Result<()> {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    // Unreaped, the child keeps its id, so the kill by id reaches no other process.
    let pid = Pid::from_raw(system_process_id(id)?.get());
    match kill(pid, Signal::SIGKILL) {
        // A child that already ended is still unreaped, so the reap below finds it.
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(errno) => return Err(io::Error::from(errno)),
    }
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => {
            drop(runtime.spawn_blocking(move || {
                if let Err(error) = reap_spawned_child(id) {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a killed child could not be reaped"
                    );
                }
            }));
            Ok(())
        }
        Err(_no_runtime) => reap_spawned_child(id).map(drop),
    }
}
