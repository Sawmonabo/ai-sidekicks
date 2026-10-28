//! Whether this user may make a user namespace and mount inside it, which a command sandbox built
//! on bubblewrap needs, and which a kernel setting or a security module can refuse.

use std::ffi::CStr;
use std::io;
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};

use nix::unistd::{getgid, getuid};

// The files a new user namespace's maps are written to, from inside it.
const SET_GROUPS_FILE: &CStr = c"/proc/self/setgroups";
const USER_MAP_FILE: &CStr = c"/proc/self/uid_map";
const GROUP_MAP_FILE: &CStr = c"/proc/self/gid_map";

// The program the check's command names; the check's child ends before it would run.
const NEVER_RUN_PROGRAM: &str = "/bin/true";

/// Whether this user may make a user namespace, map itself into it and make a mount namespace
/// there, as a bubblewrap sandbox does: a short child process tries each step and ends. Runs on the
/// daemon's spawner thread. Fails with the system's error when the child cannot be started or
/// waited for for any reason but a refused step.
pub fn can_create_user_namespace() -> io::Result<bool> {
    let (user_map, group_map) = own_id_maps();
    let mut command = Command::new(NEVER_RUN_PROGRAM);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the closure runs in the forked child before any exec and makes only `unshare`,
    // `open`, `write`, `close` and `_exit`, which are async-signal-safe, on bytes made before the
    // fork, so it allocates nothing.
    unsafe {
        command.pre_exec(move || {
            enter_own_user_namespace(&user_map, &group_map)?;
            check_step(libc::unshare(libc::CLONE_NEWNS))?;
            libc::_exit(0)
        });
    }
    match command.spawn() {
        Ok(mut child) => Ok(child.wait()?.success()),
        Err(error) if is_refused_step(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

/// The maps a new user namespace takes for this user and this group, `<id> <id> 1` each, made
/// before a fork so the child writes them without allocating.
pub(crate) fn own_id_maps() -> (Vec<u8>, Vec<u8>) {
    (
        format!("{0} {0} 1\n", getuid()).into_bytes(),
        format!("{0} {0} 1\n", getgid()).into_bytes(),
    )
}

/// Moves the calling process into a new user namespace and maps this user and group into it, as
/// a forked child does before its exec, through async-signal-safe calls only. Fails with the
/// refused step's system error.
pub(crate) fn enter_own_user_namespace(user_map: &[u8], group_map: &[u8]) -> io::Result<()> {
    // SAFETY: `unshare` takes flags only.
    check_step(unsafe { libc::unshare(libc::CLONE_NEWUSER) })?;
    write_file(SET_GROUPS_FILE, b"deny")?;
    write_file(USER_MAP_FILE, user_map)?;
    write_file(GROUP_MAP_FILE, group_map)
}

// Whether `error` is a step's refusal: no permission, no namespace support, or no room left.
fn is_refused_step(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EPERM | libc::EACCES | libc::EINVAL | libc::ENOSPC | libc::EUSERS)
    )
}

/// The step's error when `status` reports a failure.
pub(crate) fn check_step(status: libc::c_int) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

// Writes `bytes` to `file` whole, as the kernel takes a namespace map in one write.
fn write_file(file: &CStr, bytes: &[u8]) -> io::Result<()> {
    // SAFETY: the path is a NUL-ended C string, and the call answers a descriptor or -1.
    let descriptor = unsafe { libc::open(file.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor is open, and `bytes` is a live buffer of the length given.
    let written = unsafe { libc::write(descriptor, bytes.as_ptr().cast(), bytes.len()) };
    let write_error = io::Error::last_os_error();
    // SAFETY: the descriptor is open and owned here alone.
    unsafe { libc::close(descriptor) };
    if usize::try_from(written).ok() != Some(bytes.len()) {
        return Err(write_error);
    }
    Ok(())
}
