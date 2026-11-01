//! The wake helper's socket: a folder only root can write, a socket any local process may reach,
//! and a check of each connection's user against the user at the Mac's screen, read with
//! `getpeereid`, before one request line is read and answered.

use std::fs::{self, Permissions};
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::{PowerEvents, WakeBookings, WakeRefusal, WakeReply};

// The device the login window gives to the user at the Mac's screen, and back to root when no one
// is logged in there.
const CONSOLE_DEVICE: &str = "/dev/console";

// The longest request line read: a verb, a space and a count of seconds, with room to spare.
const MOST_REQUEST_BYTES: u64 = 64;

// How long one connection may take to send its request or read its reply, so a caller that stalls
// never holds the helper from the next.
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

/// Binds the helper's socket at `socket_path`: its folder is made if missing and must be a folder
/// this process owns that no one else can write, a socket a stopped helper left is removed, and
/// the socket is opened to every local user, since each connection's user is checked. Fails with
/// `PermissionDenied` when the folder is another's or others can write it, and with the system's
/// error otherwise.
pub(super) fn bind_wake_socket(socket_path: &Path) -> io::Result<UnixListener> {
    let folder = socket_path
        .parent()
        .ok_or_else(|| io::Error::other("the wake helper's socket path names no folder"))?;
    match fs::create_dir(folder) {
        Ok(()) => fs::set_permissions(folder, Permissions::from_mode(0o755))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(folder)?;
    if !metadata.is_dir()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.mode() & 0o022 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the wake helper's socket folder is not a folder only this process can write",
        ));
    }
    match fs::symlink_metadata(socket_path) {
        Ok(left) if left.file_type().is_socket() => fs::remove_file(socket_path)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "something other than a socket sits at the wake helper's socket path",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(socket_path)?;
    fs::set_permissions(socket_path, Permissions::from_mode(0o666))?;
    Ok(listener)
}

/// Answers each connection to `listener` in turn, forever, reading the user at the Mac's screen
/// for each. A connection that fails is written to standard error, which launchd keeps, and the
/// next is served; fails only when the listener cannot accept.
pub(super) fn serve_wake_connections<E: PowerEvents>(
    listener: &UnixListener,
    bookings: &mut WakeBookings<E>,
) -> io::Result<()> {
    loop {
        let (stream, _) = listener.accept()?;
        let answered = read_console_user().and_then(|console_user| {
            answer_wake_connection(&stream, console_user, bookings, SystemTime::now())
        });
        if let Err(error) = answered {
            report_connection_failure(&error);
        }
    }
}

#[expect(
    clippy::print_stderr,
    reason = "the root helper has no log of its own; launchd keeps its standard error"
)]
fn report_connection_failure(error: &io::Error) {
    eprintln!("a wake helper connection failed: {error}");
}

/// Answers one connection at `now`: refuses it with `refused notConsoleUser` unless the process at
/// its other end runs as `console_user`, the user at the Mac's screen (`None` when no one is
/// there), and otherwise reads one request line and writes the reply line. Fails with the
/// socket's error.
pub fn answer_wake_connection<E: PowerEvents>(
    stream: &UnixStream,
    console_user: Option<u32>,
    bookings: &mut WakeBookings<E>,
    now: SystemTime,
) -> io::Result<()> {
    stream.set_read_timeout(Some(CONNECTION_TIMEOUT))?;
    stream.set_write_timeout(Some(CONNECTION_TIMEOUT))?;
    let reply = if console_user == Some(read_peer_user(stream)?) {
        let mut request = String::new();
        BufReader::new(stream.take(MOST_REQUEST_BYTES)).read_line(&mut request)?;
        bookings.answer(&request, now)
    } else {
        WakeReply::Refused(WakeRefusal::NotConsoleUser)
    };
    let mut stream = stream;
    writeln!(stream, "{reply}")
}

// The user the process at the socket's other end ran as when it connected.
fn read_peer_user(stream: &UnixStream) -> io::Result<u32> {
    let mut user: libc::uid_t = 0;
    let mut group: libc::gid_t = 0;
    // SAFETY: the socket is open for the call, and both out pointers are this frame's locals.
    let status = unsafe { libc::getpeereid(stream.as_raw_fd(), &raw mut user, &raw mut group) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(user)
}

// The user at the Mac's screen, the owner of the console device; `None` while the login window
// holds it as root.
fn read_console_user() -> io::Result<Option<u32>> {
    let owner = fs::metadata(CONSOLE_DEVICE)?.uid();
    Ok((owner != 0).then_some(owner))
}
