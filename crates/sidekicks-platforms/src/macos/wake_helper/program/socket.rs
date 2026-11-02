//! One connection to the wake helper's socket, which any local process may reach: a check of its
//! user against the user at the Mac's screen, read with `getpeereid`, before one request line is
//! read and answered.

use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::net::UnixStream;
use std::time::{Duration, SystemTime};

use super::{PowerEvents, WakeBookings, WakeRefusal, WakeReply};

// The longest request line read: a verb, a space and a count of seconds, with room to spare.
const MOST_REQUEST_BYTES: u64 = 64;

// How long one connection may take to send its request or read its reply, so a caller that stalls
// never holds the helper from the next.
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

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
