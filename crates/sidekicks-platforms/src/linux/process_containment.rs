//! The daemon's hold on what it starts, on Linux: a child subreaper that no other process of the
//! account may read, and for each shell a cgroup of its own beside the daemon's, under the cgroup
//! systemd delegated to the daemon's unit, ended whole through `cgroup.kill`, which kills every
//! process in it, one that forks meanwhile included.

use std::fs::{self, File};
use std::io::{self, Read as _, Seek as _, SeekFrom};
use std::os::fd::AsRawFd as _;
use std::path::{Path, PathBuf};

use nix::sys::prctl::{set_child_subreaper, set_dumpable};

// Where the unified cgroup hierarchy is mounted.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

// The line of a process's cgroup file that names its place in the unified hierarchy.
const UNIFIED_CGROUP_PREFIX: &str = "0::";

// How long the end of a shell's cgroup waits for its killed processes to be gone.
const CGROUP_EMPTY_WAIT_MILLISECONDS: libc::c_int = 5_000;

/// Makes the daemon a child subreaper, so an orphan below it is its child rather than init's and
/// the start confirmation's writer check, not the parent check alone, refuses a `shell` mode whose
/// parent ended; and marks it not dumpable, so another process of the account cannot read its
/// memory. Fails with the system's error.
pub(crate) fn contain_daemon_descendants() -> io::Result<()> {
    set_child_subreaper(true)?;
    set_dumpable(false)?;
    Ok(())
}

/// Makes the cgroup `shell-<pid>` beside the daemon's own and moves the shell process `pid` into
/// it, answering its folder. Fails with the system's error, `PermissionDenied` where the daemon's
/// unit was given no delegated cgroup; a cgroup made but not joined is removed.
pub(crate) fn move_into_own_cgroup(pid: u32) -> io::Result<PathBuf> {
    let own = fs::read_to_string("/proc/self/cgroup")?;
    let own = own
        .lines()
        .find_map(|line| line.strip_prefix(UNIFIED_CGROUP_PREFIX))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "the daemon runs in no unified cgroup",
            )
        })?;
    let own_folder = Path::new(CGROUP_ROOT).join(own.trim_start_matches('/'));
    let parent = own_folder.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the daemon runs in the root cgroup, so no cgroup is delegated to it",
        )
    })?;
    let folder = parent.join(format!("shell-{pid}"));
    fs::create_dir(&folder)?;
    if let Err(error) = fs::write(folder.join("cgroup.procs"), pid.to_string()) {
        if let Err(removal) = fs::remove_dir(&folder) {
            tracing::warn!(
                folder = %folder.display(),
                error = &removal as &(dyn std::error::Error + 'static),
                "a shell's cgroup it could not join was not removed"
            );
        }
        return Err(error);
    }
    Ok(folder)
}

/// Kills every process left in the shell's cgroup at `folder`, waits up to five seconds for it to
/// empty and removes it. Blocking; a failure is logged, since the shell's own end has already run.
pub(crate) fn end_cgroup(folder: &Path) {
    let ended = fs::write(folder.join("cgroup.kill"), "1")
        .and_then(|()| wait_until_empty(folder))
        .and_then(|()| fs::remove_dir(folder));
    if let Err(error) = ended {
        tracing::warn!(
            folder = %folder.display(),
            error = &error as &(dyn std::error::Error + 'static),
            "a shell's cgroup was not ended and removed"
        );
    }
}

// Waits until the cgroup's events file reads `populated 0`; the kernel marks the open file with a
// priority event at each change after its last read, so the wait spins on nothing. Fails with
// `TimedOut` past the bound.
fn wait_until_empty(folder: &Path) -> io::Result<()> {
    let mut events = File::open(folder.join("cgroup.events"))?;
    loop {
        let mut text = String::new();
        events.seek(SeekFrom::Start(0))?;
        events.read_to_string(&mut text)?;
        if text.lines().any(|line| line == "populated 0") {
            return Ok(());
        }
        let mut watched = libc::pollfd {
            fd: events.as_raw_fd(),
            events: libc::POLLPRI,
            revents: 0,
        };
        // SAFETY: `watched` is one live, writable `pollfd` on an open descriptor.
        let ready = unsafe { libc::poll(&raw mut watched, 1, CGROUP_EMPTY_WAIT_MILLISECONDS) };
        match ready {
            0 => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the shell's cgroup did not empty in time",
                ));
            }
            ready if ready < 0 => return Err(io::Error::last_os_error()),
            _ => {}
        }
    }
}
