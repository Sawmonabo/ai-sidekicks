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
/// the end the variable names is an unnamed local socket whose other end the parent wrote this
/// process's id on, and the parent is its own responsible process, as the daemon is and no process
/// an agent runs is. Closes that end. Fails with `NotFound` when no end is named, `InvalidData`
/// when it is not such a socket or the confirmation is not this process's, `PermissionDenied` when
/// the parent did not write it or is not its own responsible process, `UnexpectedEof` when the
/// other end closed unwritten, and the system's error otherwise.
pub(crate) fn receive_confirmation() -> io::Result<()> {
    let descriptor = std::env::var(SHELL_START_CONFIRMATION)
        .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error))?
        .parse::<RawFd>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut end = UnixStream::from(take_socket(descriptor)?);
    if !is_unnamed_peer(&end)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation's socket is connected to a named socket",
        ));
    }
    let mut confirmed: ConfirmedId = [0; size_of::<u32>()];
    end.read_exact(&mut confirmed)?;
    let writer = read_peer_id(&end)?;
    let parent = std::os::unix::process::parent_id();
    if writer != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("process {writer}, not the parent {parent}, wrote the confirmation"),
        ));
    }
    if u32::from_ne_bytes(confirmed) != std::process::id() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation names another process",
        ));
    }
    if read_responsible_id(parent)? != Some(parent) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} is not its own responsible process"),
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

/// Whether `end` is a local socket whose other end has no name, as one of a socket pair has and a
/// connection to a listening socket does not. Fails with the system's error.
fn is_unnamed_peer(end: &UnixStream) -> io::Result<bool> {
    // SAFETY: `sockaddr_un` is a C struct of integers, for which all zero bytes are valid.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let mut length = socklen_of::<libc::sockaddr_un>();
    // SAFETY: the socket is open, and `address` is a live, writable `sockaddr_un` of the length
    // given, which the call fills.
    let status =
        unsafe { libc::getpeername(end.as_raw_fd(), (&raw mut address).cast(), &raw mut length) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(libc::c_int::from(address.sun_family) == libc::AF_UNIX && address.sun_path[0] == 0)
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
    use std::ffi::{CString, OsString};
    use std::io::{Read as _, Write as _};
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
    use std::os::unix::ffi::OsStringExt as _;
    use std::process::{Command, Output, Stdio};

    use super::{ShellStartConfirmation, receive_confirmation};
    use crate::macos::responsibility::{OwnRootStart, read_responsible_id};

    /// What the `shell` mode stand-in prints once its confirmation is received.
    const RECEIVED: &str = "the shell start was confirmed";

    /// What the own-root parent stand-in prints once every start it confirmed went as expected.
    const PARENT_CHECKED: &str = "the own-root parent's starts went as expected";

    /// This test program, run with only the test `name`, ignored ones included, its output kept.
    fn this_test_program(name: &str) -> Command {
        let mut command =
            Command::new(std::env::current_exe().expect("the test program names itself"));
        command.args(["--exact", name, "--include-ignored", "--nocapture"]);
        command
    }

    /// Starts the `shell` mode stand-in as this process's child, confirms `confirmed_id` (the
    /// child's own id when `None`) and answers its output.
    fn start_confirmed(confirmed_id: Option<u32>) -> Output {
        let mut confirmation = ShellStartConfirmation::new().expect("the pair opens");
        let (name, value) = confirmation
            .environment_entry()
            .expect("macOS confirms a shell's start");
        let child = this_test_program(
            "macos::shell_start_confirmation::tests::the_shell_mode_stand_in_receives_its_confirmation",
        )
        .env(name, value)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the stand-in starts");
        confirmation
            .confirm(confirmed_id.unwrap_or_else(|| child.id()))
            .expect("the confirmation is written");
        // Kept open until the stand-in ends, as the daemon keeps it for the shell's life.
        let output = child.wait_with_output().expect("the stand-in ends");
        drop(confirmation);
        output
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
        let own_child = start_confirmed(None);
        assert!(
            was_received(&own_child),
            "{}",
            String::from_utf8_lossy(&own_child.stderr)
        );
        assert!(!was_received(&start_confirmed(Some(own_id))));
        writeln!(std::io::stdout(), "{PARENT_CHECKED}").expect("the stand-in writes its output");
    }

    #[test]
    fn a_shell_start_is_confirmed_only_by_an_own_root_parent_naming_it() {
        // The test runs under its runner, which is responsible for it, as the daemon is for every
        // process an agent runs: its confirmation of its own child is refused.
        assert!(!was_received(&start_confirmed(None)));

        // Built before the fork, so the child makes only the exec's one system call.
        let program = std::env::current_exe().expect("the test program names itself");
        let arguments = [
            program.clone().into_os_string(),
            OsString::from("--exact"),
            OsString::from(
                "macos::shell_start_confirmation::tests::an_own_root_parent_confirms_only_the_process_it_started",
            ),
            OsString::from("--include-ignored"),
            OsString::from("--nocapture"),
        ];
        let c_string = |text: OsString| CString::new(text.into_vec()).expect("no NUL");
        let environment = std::env::vars_os()
            .map(|(mut name, value)| {
                name.push("=");
                name.push(value);
                c_string(name)
            })
            .collect();
        let start = OwnRootStart::new(
            c_string(program.into_os_string()),
            arguments.into_iter().map(c_string).collect(),
            environment,
        )
        .expect("the start prepares");
        let mut ends = [0; 2];
        // SAFETY: `ends` is a live array of the two descriptors the call fills.
        let status = unsafe { libc::pipe(ends.as_mut_ptr()) };
        assert_eq!(status, 0, "the pipe opens");
        // SAFETY: the call succeeded, so both descriptors are new and owned here alone.
        let (read_end, write_end) =
            unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        // SAFETY: the descriptor is open; the call only sets its close-on-exec flag.
        let status = unsafe { libc::fcntl(read_end.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
        assert_eq!(status, 0, "the read end closes on exec");
        let write_descriptor = write_end.as_raw_fd();

        // SAFETY: the child calls only `dup2`, `exec` and `_exit`, each async-signal-safe, so the
        // other threads' locks the fork copies are never taken.
        let child = unsafe { libc::fork() };
        if child == 0 {
            // SAFETY: both descriptors are open in the child; `dup2` makes the pipe its output.
            unsafe { libc::dup2(write_descriptor, libc::STDOUT_FILENO) };
            drop(start.exec());
            // SAFETY: `_exit` ends the child without running the parent's exit handlers.
            unsafe { libc::_exit(127) };
        }
        assert!(child > 0, "the child forks");
        drop(write_end);
        let mut output = String::new();
        std::fs::File::from(read_end)
            .read_to_string(&mut output)
            .expect("the stand-in's output reads");
        let mut status = 0;
        // SAFETY: `child` is this test's own child, which the test reaps here.
        assert_eq!(unsafe { libc::waitpid(child, &raw mut status, 0) }, child);
        assert!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "the own-root parent's checks pass: {output}"
        );
        assert!(output.contains(PARENT_CHECKED), "{output}");
    }
}
