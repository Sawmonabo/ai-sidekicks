//! The daemon's word that it started a terminal's `shell` mode, which the mode needs before it
//! starts the person's shell as its own responsible process. The daemon opens a socket pair, hands
//! one end to the mode it starts, and writes the id of the process it started on the other; the
//! mode starts the shell only when its parent wrote its own id there and is its own responsible
//! process. An agent's command that runs the daemon's program in the `shell` mode itself has no
//! such parent: every process it starts reads the daemon as responsible, and the daemon writes no
//! other process's id, so the mode refuses and nothing an agent runs becomes its own responsible
//! process through it.

use std::io::{self, Read as _, Write as _};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

use crate::macos::responsibility::read_responsible_id;

/// The environment variable that carries the number of the mode's end of the socket pair.
const SHELL_START_CONFIRMATION: &str = "SIDEKICKS_SHELL_START_CONFIRMATION";

/// The bytes the confirmation carries: the started process's id.
type ConfirmedId = [u8; size_of::<u32>()];

/// The daemon's side of one shell start's confirmation: the socket pair, its shell end inherited
/// by the `shell` mode the daemon starts next. The daemon keeps it until that shell has ended,
/// since the mode reads who wrote the confirmation only while the daemon's end is open.
pub struct ShellStartConfirmation {
    /// The end the daemon writes the started process's id on; closed on exec, and when this drops.
    daemon_end: UnixStream,
    /// The end the `shell` mode inherits; closed in the daemon once the confirmation is written.
    shell_end: Option<OwnedFd>,
}

impl ShellStartConfirmation {
    /// Opens the pair for the next shell's start. Runs on the daemon's spawner thread, which
    /// starts every child the daemon starts, right before the shell's start; the shell's end stays
    /// open across an exec, and that thread starts no other child before [`Self::confirm`] closes
    /// it, so no other child inherits it. Fails with the system's error.
    pub fn new() -> io::Result<Self> {
        let mut ends: [RawFd; 2] = [0; 2];
        // SAFETY: `ends` is a live array of the two descriptors the call fills.
        let status =
            unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, ends.as_mut_ptr()) };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call succeeded, so both descriptors are new and owned here alone.
        let (daemon_end, shell_end) =
            unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        // SAFETY: the descriptor is open; the call only sets its close-on-exec flag.
        if unsafe { libc::fcntl(daemon_end.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let is_on: libc::c_int = 1;
        // SAFETY: the descriptor is open and the value is a live int of the length given; a write
        // to an ended shell then fails with `EPIPE` instead of raising `SIGPIPE`.
        let status = unsafe {
            libc::setsockopt(
                daemon_end.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&raw const is_on).cast(),
                socklen_of::<libc::c_int>(),
            )
        };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            daemon_end: UnixStream::from(daemon_end),
            shell_end: Some(shell_end),
        })
    }

    /// The variable and value the `shell` mode's environment carries so the mode finds its end;
    /// `None` once the confirmation is written.
    pub fn environment_entry(&self) -> Option<(String, String)> {
        self.shell_end.as_ref().map(|shell_end| {
            (
                SHELL_START_CONFIRMATION.to_owned(),
                shell_end.as_raw_fd().to_string(),
            )
        })
    }

    /// Closes the daemon's copy of the shell's end and confirms that the daemon started process
    /// `shell_process_id`. Fails with the system's error, `EPIPE` when the mode has already ended.
    pub fn confirm(&mut self, shell_process_id: u32) -> io::Result<()> {
        drop(self.shell_end.take());
        self.daemon_end.write_all(&shell_process_id.to_ne_bytes())
    }
}

/// Waits for the confirmation that this process's parent started it as a terminal's `shell` mode:
/// the end the variable names is a local socket whose other end the parent wrote this process's id
/// on, and the parent, still this process's parent once read, is its own responsible process, as
/// the daemon is and no process an agent runs is. Closes that end. Fails with `NotFound` when no
/// end is named, `InvalidData` when it is not a socket or the confirmation is not this process's,
/// `PermissionDenied` when the parent did not write it, is not its own responsible process or
/// ended while it was read, `UnexpectedEof` when the other end closed unwritten, and the system's
/// error otherwise.
pub(crate) fn receive_confirmation() -> io::Result<()> {
    let descriptor = std::env::var(SHELL_START_CONFIRMATION)
        .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error))?
        .parse::<RawFd>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut end = UnixStream::from(take_socket(descriptor)?);
    let mut confirmed: ConfirmedId = [0; size_of::<u32>()];
    end.read_exact(&mut confirmed)?;
    let writer = read_peer_id(&end)?;
    let parent = std::os::unix::process::parent_id();
    if u32::from_ne_bytes(confirmed) != std::process::id() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation names another process",
        ));
    }
    let is_own_root = read_responsible_id(parent)? == Some(parent);
    check_confirming_parent(writer, parent, std::os::unix::process::parent_id())?;
    if !is_own_root {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} is not its own responsible process"),
        ));
    }
    Ok(())
}

/// Checks that the confirmation's writer is this process's parent, read as `parent` before the
/// parent's responsible read and as `parent_after` after it. A parent that ended re-parents this
/// process, so an unchanged parent is the one read, never another process given its id. Fails with
/// `PermissionDenied` when another process wrote it or the parent changed between the reads.
fn check_confirming_parent(writer: u32, parent: u32, parent_after: u32) -> io::Result<()> {
    if writer != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("process {writer}, not the parent {parent}, wrote the confirmation"),
        ));
    }
    if parent_after != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} ended while the confirmation was read"),
        ));
    }
    Ok(())
}

/// The open socket `descriptor` names, taken over so it closes with the value. Fails with
/// `InvalidData` for a standard stream's descriptor or one that is not a socket, and with the
/// system's error for one that is not open.
fn take_socket(descriptor: RawFd) -> io::Result<OwnedFd> {
    if descriptor <= libc::STDERR_FILENO {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation names a standard stream",
        ));
    }
    // SAFETY: `stat` is a C struct of integers, for which all zero bytes are valid.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `status` is a live, writable `stat` the call fills; a closed descriptor fails.
    if unsafe { libc::fstat(descriptor, &raw mut status) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if status.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation's descriptor is not a socket",
        ));
    }
    // SAFETY: the descriptor is open, and nothing else in this process uses it: it was inherited
    // for this read alone.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

/// The id of the process that last used the other end of `end`. Fails with the system's error.
fn read_peer_id(end: &UnixStream) -> io::Result<u32> {
    let mut peer: libc::pid_t = 0;
    let mut length = socklen_of::<libc::pid_t>();
    // SAFETY: the socket is open, and `peer` is a live, writable `pid_t` of the length given.
    let status = unsafe {
        libc::getsockopt(
            end.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut peer).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(peer).map_err(io::Error::other)
}

/// The size of `T` as a socket call takes it.
fn socklen_of<T>() -> libc::socklen_t {
    libc::socklen_t::try_from(size_of::<T>()).expect("a socket value's size fits a socklen_t")
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::io::Write as _;
    use std::os::fd::OwnedFd;
    use std::process::{Command, Output, Stdio};

    use super::{ShellStartConfirmation, check_confirming_parent, receive_confirmation};
    use crate::macos::responsibility::{
        read_responsible_id, run_test_as_own_root, this_test_program,
    };

    /// The `shell` mode stand-in's test.
    const SHELL_MODE_STAND_IN: &str =
        "macos::shell_start_confirmation::tests::the_shell_mode_stand_in_receives_its_confirmation";

    /// What the `shell` mode stand-in prints once its confirmation is received.
    const RECEIVED: &str = "the shell start was confirmed";

    /// What the own-root parent stand-in prints once every start it confirmed went as expected.
    const PARENT_CHECKED: &str = "the own-root parent's starts went as expected";

    /// Who writes the confirmation of the `shell` mode stand-in this process starts.
    enum Writer {
        /// This process, naming the child's own id.
        ThisProcessNamingTheChild,
        /// This process, naming `id`.
        ThisProcessNaming(u32),
        /// Another process, a child of this one, naming the stand-in's own id on this process's
        /// end, which this process keeps open.
        AnotherProcessNamingTheChild,
    }

    /// Starts the `shell` mode stand-in as this process's child, has `writer` confirm it and
    /// answers its output.
    fn start_confirmed(writer: &Writer) -> Output {
        let mut confirmation = ShellStartConfirmation::new().expect("the pair opens");
        let (name, value) = confirmation
            .environment_entry()
            .expect("macOS confirms a shell's start");
        let child = this_test_program(SHELL_MODE_STAND_IN)
            .env(name, value)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the stand-in starts");
        match writer {
            Writer::ThisProcessNamingTheChild => confirmation.confirm(child.id()),
            Writer::ThisProcessNaming(id) => confirmation.confirm(*id),
            Writer::AnotherProcessNamingTheChild => {
                drop(confirmation.shell_end.take());
                write_from_another_process(&confirmation, child.id());
                Ok(())
            }
        }
        .expect("the confirmation is written");
        // Kept open until the stand-in ends, as the daemon keeps it for the shell's life.
        let output = child.wait_with_output().expect("the stand-in ends");
        drop(confirmation);
        output
    }

    /// Has a shell, this process's child, write `id` on a copy of the daemon's end of
    /// `confirmation`.
    fn write_from_another_process(confirmation: &ShellStartConfirmation, id: u32) {
        let daemon_end = OwnedFd::from(
            confirmation
                .daemon_end
                .try_clone()
                .expect("the daemon's end copies"),
        );
        let mut escaped = String::new();
        for byte in id.to_ne_bytes() {
            write!(escaped, "\\{byte:03o}").expect("a string takes every write");
        }
        let status = Command::new("/bin/sh")
            .args(["-c", "printf \"$1\"", "sh", &escaped])
            .stdout(Stdio::from(daemon_end))
            .status()
            .expect("the writer runs");
        assert!(status.success(), "the writer wrote the id");
    }

    /// Whether the stand-in that printed `output` received its confirmation.
    fn was_received(output: &Output) -> bool {
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains(RECEIVED)
    }

    #[test]
    #[ignore = "the `shell` mode's stand-in, which the confirmation tests start as their child"]
    fn the_shell_mode_stand_in_receives_its_confirmation() {
        receive_confirmation().expect("the confirmation is received");
        writeln!(std::io::stdout(), "{RECEIVED}").expect("the stand-in writes its output");
    }

    #[test]
    #[ignore = "the daemon's stand-in, which the confirmation test starts as its own responsible \
                process"]
    fn an_own_root_parent_confirms_only_the_process_it_started() {
        let own_id = std::process::id();
        assert_eq!(
            read_responsible_id(own_id).expect("the read answers"),
            Some(own_id),
            "the stand-in started as its own responsible process"
        );
        let own_child = start_confirmed(&Writer::ThisProcessNamingTheChild);
        assert!(
            was_received(&own_child),
            "{}",
            String::from_utf8_lossy(&own_child.stderr)
        );
        assert!(!was_received(&start_confirmed(&Writer::ThisProcessNaming(
            own_id
        ))));
        // A process other than the parent writing the stand-in's own id on a held end is refused.
        assert!(!was_received(&start_confirmed(
            &Writer::AnotherProcessNamingTheChild
        )));
        writeln!(std::io::stdout(), "{PARENT_CHECKED}").expect("the stand-in writes its output");
    }

    #[test]
    fn a_parent_that_changed_while_it_was_read_is_refused() {
        // The parent wrote the confirmation and ended before its responsible read, so this process
        // was re-parented and the id read may name another process.
        let error = check_confirming_parent(500, 500, 1).expect_err("the confirmation is refused");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn a_shell_start_is_confirmed_only_by_an_own_root_parent_naming_it() {
        // The test runs under its runner, which is responsible for it, as the daemon is for every
        // process an agent runs: its confirmation of its own child is refused.
        assert!(!was_received(&start_confirmed(
            &Writer::ThisProcessNamingTheChild
        )));
        let (has_passed, output) = run_test_as_own_root(
            "macos::shell_start_confirmation::tests::an_own_root_parent_confirms_only_the_process_it_started",
        );
        assert!(
            has_passed && output.contains(PARENT_CHECKED),
            "the own-root parent's checks pass: {output}"
        );
    }
}
