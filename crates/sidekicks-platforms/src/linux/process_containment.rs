//! The daemon's hold on what it starts, on Linux: a child subreaper that no other process of the
//! account may read, and, where systemd delegated the daemon's own cgroup to it, a cgroup of its
//! own for each shell inside that one, ended whole. systemd marks a delegated cgroup with the
//! `trusted.delegate` or `user.delegate` attribute and forbids making cgroups below any other it
//! manages, so the daemon makes none without the mark; it first moves itself into the leaf `daemon`
//! inside its cgroup, since a cgroup with processes of its own holds no cgroup a controller
//! reaches, then puts each shell in `shell-<pid>` beside that leaf, so stopping the daemon's unit
//! still reaches every shell. Without the mark, in the root cgroup, or with no unified hierarchy
//! mounted (its mount read from `/proc/self/mountinfo`), no cgroup is made, which the start logs
//! once, and the orphan sweep's search by nonce still finds what a crash leaves. A shell's cgroup
//! is ended through `cgroup.kill`, which kills every process in it, one that forks meanwhile
//! included, or on a kernel before 5.14, which has no such file, by killing each process it lists
//! until none is left; it is removed whatever the kill did, and the start's sweep removes every
//! `shell-*` cgroup a previous run left, killing what still runs in one.

use std::ffi::{CStr, CString, OsStr};
use std::fs::{self, File};
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use nix::sys::prctl::{set_child_subreaper, set_dumpable};
use nix::sys::signal::Signal;

use crate::linux::pinned_process::{PinnedProcess, pin_running_process};
use crate::linux::unescape_mount_point;

// The mount table of this process's mount namespace, one mount per line with its root.
const MOUNT_INFO_PATH: &str = "/proc/self/mountinfo";

// The cgroups this process runs in, one line per hierarchy.
const OWN_CGROUP_PATH: &str = "/proc/self/cgroup";

// The file system type of the unified cgroup hierarchy.
const UNIFIED_FILE_SYSTEM: &str = "cgroup2";

// The line of a process's cgroup file that names its place in the unified hierarchy.
const UNIFIED_CGROUP_PREFIX: &str = "0::";

// The attributes systemd marks a delegated cgroup with: the trusted one where systemd runs as
// root, the user one where a user's manager does.
const DELEGATE_MARKS: [&CStr; 2] = [c"trusted.delegate", c"user.delegate"];

// The leaf the daemon moves itself into inside its delegated cgroup.
const DAEMON_LEAF_NAME: &str = "daemon";

// The start of each shell's cgroup's name; the shell's process id follows.
const SHELL_CGROUP_PREFIX: &str = "shell-";

// A cgroup's files: the processes in it, the switch that kills them all, and its events.
const PROCESSES_FILE: &str = "cgroup.procs";
const KILL_FILE: &str = "cgroup.kill";
const EVENTS_FILE: &str = "cgroup.events";

// How long ending a shell's cgroup waits for its killed processes to be gone.
const CGROUP_END_BOUND: Duration = Duration::from_secs(5);

/// The daemon's delegated cgroup, each shell's cgroup made inside it; unset where the daemon took
/// none.
static SHELL_CGROUP_PARENT: OnceLock<PathBuf> = OnceLock::new();

/// Makes this process a child subreaper, so an orphan below it becomes its child rather than
/// init's. Fails with the system's error.
pub(crate) fn take_in_orphans() -> io::Result<()> {
    Ok(set_child_subreaper(true)?)
}

/// Makes the daemon a child subreaper, so an orphan below it is its child rather than init's and
/// the start confirmation's writer check, not the parent check alone, refuses a `shell` mode whose
/// parent ended; marks it not dumpable, so another process of the account cannot read its memory;
/// and takes its delegated cgroup for the shells' cgroups, where it has one, logging why it has
/// none. Called once, at the start. Fails with the system's error from the first two.
pub(crate) fn contain_daemon_descendants() -> io::Result<()> {
    take_in_orphans()?;
    set_dumpable(false)?;
    let taken = fs::read_to_string(MOUNT_INFO_PATH)
        .and_then(|mount_info| Ok((mount_info, fs::read_to_string(OWN_CGROUP_PATH)?)))
        .and_then(|(mount_info, own_cgroup)| {
            take_delegated_cgroup(&mount_info, &own_cgroup, std::process::id())
        });
    match taken {
        Ok(Some(own)) => {
            SHELL_CGROUP_PARENT.get_or_init(|| own);
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "the daemon's cgroup could not be taken, so no shell gets a cgroup of its own"
        ),
    }
    Ok(())
}

/// One shell's cgroup, ended and removed as it drops: off the runtime's workers, through its
/// blocking pool, when dropped inside the runtime, and in place otherwise.
pub(crate) struct ShellCgroup {
    folder: PathBuf,
}

impl Drop for ShellCgroup {
    fn drop(&mut self) {
        let folder = std::mem::take(&mut self.folder);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(move || end_cgroup(&folder))),
            Err(_outside_runtime) => end_cgroup(&folder),
        }
    }
}

/// Makes the cgroup `shell-<pid>` in the daemon's delegated cgroup and moves the shell process
/// `pid` into it; `None` where the daemon took no cgroup. A cgroup of that name a crash left is
/// ended first. Fails with the system's error; a cgroup made but not joined is removed.
pub(crate) fn contain_shell(pid: u32) -> io::Result<Option<ShellCgroup>> {
    let Some(parent) = SHELL_CGROUP_PARENT.get() else {
        return Ok(None);
    };
    move_into_shell_cgroup(parent, pid).map(Some)
}

/// Ends every `shell-*` cgroup a previous run left in the daemon's delegated cgroup, killing what
/// still runs in one; nothing where the daemon took no cgroup. Blocking; a failure is logged.
pub(crate) fn end_leftover_shell_cgroups() {
    if let Some(parent) = SHELL_CGROUP_PARENT.get() {
        end_leftover_shell_cgroups_in(parent);
    }
}

// The daemon's own cgroup, taken for the shells' cgroups: on the unified hierarchy, outside the
// root and marked delegated, with the daemon `daemon_pid` moved into its `daemon` leaf; `None`,
// logged, where it is none of those.
fn take_delegated_cgroup(
    mount_info: &str,
    own_cgroup: &str,
    daemon_pid: u32,
) -> io::Result<Option<PathBuf>> {
    let Some(mount) = unified_mount(mount_info) else {
        tracing::info!(
            "no unified cgroup hierarchy is mounted, so no shell gets a cgroup of its own"
        );
        return Ok(None);
    };
    let Some(own) = own_cgroup_folder(&mount, own_cgroup) else {
        tracing::info!(
            "the daemon runs in the root cgroup or none of the unified hierarchy, so no shell gets \
             a cgroup of its own"
        );
        return Ok(None);
    };
    if !is_delegated(&own)? {
        tracing::info!(
            cgroup = %own.display(),
            "the daemon's cgroup was not delegated to it, so no shell gets a cgroup of its own"
        );
        return Ok(None);
    }
    let leaf = own.join(DAEMON_LEAF_NAME);
    if let Err(error) = fs::create_dir(&leaf)
        && error.kind() != io::ErrorKind::AlreadyExists
    {
        return Err(error);
    }
    fs::write(leaf.join(PROCESSES_FILE), daemon_pid.to_string())?;
    Ok(Some(own))
}

// Where the unified hierarchy is mounted, with the cgroup its mount shows as its root.
struct UnifiedMount {
    root: PathBuf,
    mount_point: PathBuf,
}

// The first unified hierarchy's mount in `mount_info`, each line's fourth and fifth fields its root
// and mount point and the first field after the ` - ` separator its file system type.
fn unified_mount(mount_info: &str) -> Option<UnifiedMount> {
    mount_info.lines().find_map(|line| {
        let (fields, after_separator) = line.split_once(" - ")?;
        if after_separator.split(' ').next()? != UNIFIED_FILE_SYSTEM {
            return None;
        }
        let mut fields = fields.split(' ').skip(3);
        let decode = |field: Option<&str>| {
            field.map(|field| {
                PathBuf::from(OsStr::from_bytes(&unescape_mount_point(field.as_bytes())))
            })
        };
        Some(UnifiedMount {
            root: decode(fields.next())?,
            mount_point: decode(fields.next())?,
        })
    })
}

// The folder of the cgroup `own_cgroup` names in the unified hierarchy under `mount`; `None` for
// the root cgroup, which is no cgroup of the daemon's own, a cgroup outside the mount's root, or a
// file naming none.
fn own_cgroup_folder(mount: &UnifiedMount, own_cgroup: &str) -> Option<PathBuf> {
    let own = Path::new(
        own_cgroup
            .lines()
            .find_map(|line| line.strip_prefix(UNIFIED_CGROUP_PREFIX))?,
    );
    let relative = own.strip_prefix(&mount.root).ok()?;
    (!relative.as_os_str().is_empty()).then(|| mount.mount_point.join(relative))
}

// Whether `folder` carries either delegation mark; a file system with no attributes carries none.
fn is_delegated(folder: &Path) -> io::Result<bool> {
    let path = CString::new(folder.as_os_str().as_bytes())?;
    for mark in DELEGATE_MARKS {
        // SAFETY: both names are live NUL-ended strings, and a null buffer of length 0 asks only
        // for the value's size.
        let size =
            unsafe { libc::lgetxattr(path.as_ptr(), mark.as_ptr(), std::ptr::null_mut(), 0) };
        if size >= 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ENODATA) => {}
            Some(libc::ENOTSUP) => return Ok(false),
            _ => return Err(error),
        }
    }
    Ok(false)
}

// Makes `shell-<pid>` in `parent`, ending one a crash left first, and moves process `pid` into it.
fn move_into_shell_cgroup(parent: &Path, pid: u32) -> io::Result<ShellCgroup> {
    let folder = parent.join(format!("{SHELL_CGROUP_PREFIX}{pid}"));
    if let Err(error) = fs::create_dir(&folder) {
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
        end_cgroup(&folder);
        fs::create_dir(&folder)?;
    }
    if let Err(error) = fs::write(folder.join(PROCESSES_FILE), pid.to_string()) {
        if let Err(removal) = fs::remove_dir(&folder) {
            tracing::warn!(
                folder = %folder.display(),
                error = &removal as &(dyn std::error::Error + 'static),
                "a shell's cgroup it could not join was not removed"
            );
        }
        return Err(error);
    }
    Ok(ShellCgroup { folder })
}

// Ends every `shell-*` cgroup in `parent`; a failure is logged.
fn end_leftover_shell_cgroups_in(parent: &Path) {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(
                cgroup = %parent.display(),
                error = &error as &(dyn std::error::Error + 'static),
                "the shells' cgroups a previous run left could not be listed"
            );
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry)
                if entry
                    .file_name()
                    .as_bytes()
                    .starts_with(SHELL_CGROUP_PREFIX.as_bytes())
                    && entry.file_type().is_ok_and(|file_type| file_type.is_dir()) =>
            {
                end_cgroup(&entry.path());
            }
            Ok(_other) => {}
            Err(error) => tracing::warn!(
                cgroup = %parent.display(),
                error = &error as &(dyn std::error::Error + 'static),
                "a cgroup a previous run left could not be read"
            ),
        }
    }
}

// Kills every process left in the shell's cgroup at `folder`, waits up to five seconds for them to
// be gone, and removes it whatever the kill did. Blocking; a failure is logged, since the shell's
// own end has already run.
fn end_cgroup(folder: &Path) {
    if let Err(error) = kill_cgroup(folder) {
        tracing::warn!(
            folder = %folder.display(),
            error = &error as &(dyn std::error::Error + 'static),
            "a shell's cgroup was not emptied"
        );
    }
    if let Err(error) = fs::remove_dir(folder)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(
            folder = %folder.display(),
            error = &error as &(dyn std::error::Error + 'static),
            "a shell's cgroup was not removed"
        );
    }
}

// Kills every process in the cgroup at `folder` and waits until none is left: through its kill
// switch where the kernel has one, else each listed process in turn. Fails with `TimedOut` past
// the bound, else with the system's error.
fn kill_cgroup(folder: &Path) -> io::Result<()> {
    let give_up_at = Instant::now() + CGROUP_END_BOUND;
    match fs::OpenOptions::new()
        .write(true)
        .open(folder.join(KILL_FILE))
    {
        Ok(mut kill) => {
            kill.write_all(b"1")?;
            wait_until_empty(folder, give_up_at)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            kill_each_member(folder, give_up_at)
        }
        Err(error) => Err(error),
    }
}

// Kills each process the cgroup at `folder` lists until it lists none still running: each pinned,
// then killed through its pin only while the cgroup still lists it after the pin, so a process
// given a listed id once its holder ended is never signaled; a process forked meanwhile is listed
// in the next round. Fails with `TimedOut` past `give_up_at`, else with the system's error.
fn kill_each_member(folder: &Path, give_up_at: Instant) -> io::Result<()> {
    loop {
        let mut pinned: Vec<PinnedProcess> = Vec::new();
        for id in read_member_ids(folder)? {
            if let Some(member) = pin_running_process(id)?
                && !member.wait_for_exit(Duration::ZERO)?
            {
                pinned.push(member);
            }
        }
        let listed = read_member_ids(folder)?;
        let mut killed = Vec::with_capacity(pinned.len());
        for member in pinned {
            if listed.contains(&member.id())
                && member.send_through_descriptor(Signal::SIGKILL, 0)?
            {
                killed.push(member);
            }
        }
        if killed.is_empty() {
            return Ok(());
        }
        for member in &killed {
            if !member.wait_for_exit(give_up_at.saturating_duration_since(Instant::now()))? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "a process in a shell's cgroup outlived its kill",
                ));
            }
        }
    }
}

// The ids the cgroup at `folder` lists; none once the cgroup is gone.
fn read_member_ids(folder: &Path) -> io::Result<Vec<u32>> {
    match fs::read_to_string(folder.join(PROCESSES_FILE)) {
        Ok(listed) => listed
            .lines()
            .map(|line| {
                line.trim()
                    .parse()
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
            })
            .collect(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

// Waits until the cgroup's events file reads `populated 0`; the kernel marks the open file with a
// priority event at each change after its last read, so the wait spins on nothing. Fails with
// `TimedOut` past `give_up_at`.
fn wait_until_empty(folder: &Path, give_up_at: Instant) -> io::Result<()> {
    let mut events = File::open(folder.join(EVENTS_FILE))?;
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
        let remaining = give_up_at.saturating_duration_since(Instant::now());
        let timeout = libc::c_int::try_from(remaining.as_millis()).unwrap_or(libc::c_int::MAX);
        // SAFETY: `watched` is one live, writable `pollfd` on an open descriptor.
        let ready = unsafe { libc::poll(&raw mut watched, 1, timeout) };
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

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::Path;
    use std::process::{Child, Command};

    use super::{
        UnifiedMount, end_cgroup, end_leftover_shell_cgroups_in, own_cgroup_folder,
        take_delegated_cgroup, unified_mount,
    };

    // A mount table with a v1 controller mounted first and the unified hierarchy, its path escaped,
    // at `mount_point`.
    fn mount_info(mount_point: &Path) -> String {
        let escaped = mount_point.to_string_lossy().replace(' ', "\\040");
        format!(
            "30 24 0:26 / /sys/fs/cgroup/cpu rw,nosuid shared:9 - cgroup cgroup rw,cpu\n\
             31 24 0:27 / {escaped} rw,nosuid,nodev shared:10 - cgroup2 cgroup2 rw\n"
        )
    }

    // A child that waits, the cgroup tests' stand-in for a shell's process.
    fn waiting_child() -> Child {
        Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("the child starts")
    }

    fn mark_delegated(folder: &Path) {
        let path = CString::new(folder.as_os_str().as_bytes()).expect("a path holds no NUL");
        // SAFETY: the path and the name are live NUL-ended strings and the value is one live byte.
        let status = unsafe {
            libc::setxattr(
                path.as_ptr(),
                c"user.delegate".as_ptr(),
                b"1".as_ptr().cast(),
                1,
                0,
            )
        };
        assert_eq!(status, 0, "{}", std::io::Error::last_os_error());
    }

    // Fails when a cgroup is taken without the delegation mark, which makes cgroups below one
    // systemd manages, or in the root cgroup or with no unified hierarchy; or when the daemon is
    // left out of its `daemon` leaf, or the mount is read from the wrong line or field.
    #[test]
    fn only_a_delegated_cgroup_is_taken_with_the_daemon_moved_into_its_leaf() {
        let tree = tempfile::tempdir().expect("a scratch folder");
        let mount_point = tree.path().join("unified hierarchy");
        let own = mount_point.join("user.slice/app.service");
        fs::create_dir_all(&own).expect("the cgroup folder is made");
        let mount_info = mount_info(&mount_point);
        let own_cgroup = "1:cpu:/elsewhere\n0::/user.slice/app.service\n";

        let undelegated = take_delegated_cgroup(&mount_info, own_cgroup, 42);
        mark_delegated(&own);
        let root = take_delegated_cgroup(&mount_info, "0::/\n", 42);
        let no_unified =
            take_delegated_cgroup("30 24 0:26 / /x rw - cgroup cgroup rw\n", own_cgroup, 42);
        let delegated = take_delegated_cgroup(&mount_info, own_cgroup, 42);

        assert_eq!(undelegated.expect("the undelegated cgroup reads"), None);
        assert_eq!(root.expect("the root cgroup reads"), None);
        assert_eq!(no_unified.expect("the v1 tree reads"), None);
        assert_eq!(
            delegated.expect("the delegated cgroup reads"),
            Some(own.clone())
        );
        assert_eq!(
            fs::read_to_string(own.join("daemon/cgroup.procs")).expect("the leaf lists the daemon"),
            "42"
        );
    }

    // Fails when a mount's root other than `/` is not taken off the process's cgroup path, or a
    // cgroup outside that root is mapped below the mount point.
    #[test]
    fn a_cgroup_under_a_mount_s_own_root_is_found_below_its_mount_point() {
        let mount = unified_mount("40 30 0:30 /outer /mnt/cg rw - cgroup2 cgroup2 rw\n")
            .expect("the unified hierarchy is found");
        let UnifiedMount { root, mount_point } = &mount;

        assert_eq!(root, Path::new("/outer"));
        assert_eq!(mount_point, Path::new("/mnt/cg"));
        assert_eq!(
            own_cgroup_folder(&mount, "0::/outer/app.service\n"),
            Some(Path::new("/mnt/cg/app.service").to_path_buf())
        );
        assert_eq!(own_cgroup_folder(&mount, "0::/elsewhere/x\n"), None);
    }

    // Fails when a cgroup with no kill switch, as before Linux 5.14, is left running, or is not
    // removed once its processes are gone.
    #[test]
    fn a_cgroup_with_no_kill_switch_has_each_listed_process_killed() {
        let tree = tempfile::tempdir().expect("a scratch folder");
        let mut child = waiting_child();
        let folder = tree.path().join("shell-1");
        fs::create_dir(&folder).expect("the cgroup folder is made");
        fs::write(folder.join("cgroup.procs"), format!("{}\n", child.id()))
            .expect("the cgroup lists the child");

        end_cgroup(&folder);
        let ended = child.wait().expect("the child is reaped");
        // A real cgroup's files go with it; a folder here keeps its list, so it is cleared and
        // ended again to show the removal is always tried.
        fs::remove_file(folder.join("cgroup.procs")).expect("the list is cleared");
        end_cgroup(&folder);

        assert_eq!(ended.signal(), Some(libc::SIGKILL));
        assert!(!folder.exists());
    }

    // Fails when the sweep leaves a previous run's shell cgroup, empty or holding a process, or
    // touches the daemon's own leaf or another cgroup.
    #[test]
    fn the_start_s_sweep_ends_every_shell_cgroup_a_previous_run_left() {
        let tree = tempfile::tempdir().expect("a scratch folder");
        let mut child = waiting_child();
        let empty = tree.path().join("shell-1");
        let populated = tree.path().join("shell-2");
        let daemon = tree.path().join("daemon");
        let other = tree.path().join("other");
        for folder in [&empty, &populated, &daemon, &other] {
            fs::create_dir(folder).expect("the cgroup folder is made");
        }
        fs::write(populated.join("cgroup.procs"), format!("{}\n", child.id()))
            .expect("the cgroup lists the child");

        end_leftover_shell_cgroups_in(tree.path());
        let ended = child.wait().expect("the child is reaped");

        assert_eq!(ended.signal(), Some(libc::SIGKILL));
        assert!(!empty.exists());
        assert!(daemon.exists());
        assert!(other.exists());
    }
}
