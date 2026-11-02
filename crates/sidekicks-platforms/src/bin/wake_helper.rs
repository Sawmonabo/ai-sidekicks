//! `sidekicks-wake-helper`, the macOS root program launchd starts from a property list in
//! `/Library/LaunchDaemons` when a connection reaches the socket it holds for the helper: it books
//! and cancels the wakes from sleep the console user's service asks for over that socket, and does
//! nothing else. It answers each connection in turn and exits once none has come for a while, so
//! no root process stays running between requests; launchd starts it again on the next. It
//! includes its module and the socket's message file by path rather than linking this crate's
//! library, so a program running as root carries only the power-event calls.
#![warn(dead_code_pub_in_binary)]
#![cfg_attr(
    target_os = "macos",
    expect(
        unsafe_code,
        reason = "the power-event calls (`IOPMSchedulePowerEvent`, \
                  `IOPMCancelScheduledPowerEvent`), the cast of the queue's listing \
                  (`IOPMCopyScheduledPowerEvents`) to its element types, the socket's peer read \
                  (`getpeereid`), launchd's hand-over of the socket (`launch_activate_socket`) and \
                  the wait for a connection (`poll`) are C interfaces"
    )
)]

#[cfg(target_os = "macos")]
#[path = "../wake_helper/message.rs"]
pub mod message;
#[cfg(target_os = "macos")]
#[path = "../macos/wake_helper/program.rs"]
pub mod program;

// The program's module names the message types at `crate::`, where the library's root has them too.
#[cfg(target_os = "macos")]
use message::{WakeRefusal, WakeReply, WakeRequest};

#[cfg(target_os = "macos")]
fn main() -> std::io::Result<()> {
    activation::serve_until_idle()
}

// Linux books its wakes through a systemd timer and Windows needs no helper, so the program has
// nothing to run there.
#[cfg(not(target_os = "macos"))]
fn main() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "the wake helper runs only on macOS",
    ))
}

/// One start of the helper: the socket launchd hands it, and each connection answered in turn
/// until the socket stays quiet.
#[cfg(target_os = "macos")]
mod activation {
    use std::ffi::{CString, c_char, c_int};
    use std::fs;
    use std::io;
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::net::UnixListener;
    use std::time::{Duration, SystemTime};

    use crate::program::{
        SystemPowerEvents, WAKE_HELPER_SOCKET_NAME, WakeBookings, answer_wake_connection,
    };

    // The device the login window gives to the user at the Mac's screen, and back to root when no
    // one is logged in there.
    const CONSOLE_DEVICE: &str = "/dev/console";

    // How long the helper waits for the next connection before it exits; past launchd's ten
    // seconds, so a quick exit never reads to launchd as a crash and is never held back.
    const IDLE_EXIT: Duration = Duration::from_secs(30);

    unsafe extern "C" {
        // libSystem's hand-over of the sockets launchd holds for this job under `name`; the
        // descriptor array is the caller's to free.
        fn launch_activate_socket(
            name: *const c_char,
            fds: *mut *mut c_int,
            count: *mut usize,
        ) -> c_int;
    }

    /// Takes the socket launchd holds for the helper, reads back the wakes it booked from the
    /// system's queue, and answers each connection in turn, reading the user at the Mac's screen
    /// for each, until none comes for [`IDLE_EXIT`]. A connection that fails is written to standard
    /// error, which launchd keeps, and the next is served. Fails when launchd hands over no socket
    /// or the socket cannot be waited on or accepted from.
    pub(crate) fn serve_until_idle() -> io::Result<()> {
        let listener = take_activated_socket()?;
        // An accepted connection takes the listener's blocking mode on macOS, and each is read
        // with its own timeouts.
        listener.set_nonblocking(false)?;
        let mut bookings = WakeBookings::new(SystemPowerEvents::new());
        while is_connection_waiting(&listener, IDLE_EXIT)? {
            let (stream, _) = listener.accept()?;
            let answered = read_console_user().and_then(|console_user| {
                answer_wake_connection(&stream, console_user, &mut bookings, SystemTime::now())
            });
            if let Err(error) = answered {
                report_connection_failure(&error);
            }
        }
        Ok(())
    }

    // The socket launchd bound for the helper under its list's name; any other launchd handed
    // over is closed. Fails with launchd's error number, `ESRCH` when launchd did not start this
    // process.
    fn take_activated_socket() -> io::Result<UnixListener> {
        let name = CString::new(WAKE_HELPER_SOCKET_NAME).expect("the socket's name holds no NUL");
        let mut descriptors: *mut c_int = std::ptr::null_mut();
        let mut count: usize = 0;
        // SAFETY: the name is a NUL-ended string, and both out pointers are this frame's locals.
        let status =
            unsafe { launch_activate_socket(name.as_ptr(), &raw mut descriptors, &raw mut count) };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        let handed: Vec<OwnedFd> = if descriptors.is_null() {
            Vec::new()
        } else {
            // SAFETY: launchd answered an array of `count` descriptors handed this process alone.
            let raw = unsafe { std::slice::from_raw_parts(descriptors, count) };
            raw.iter()
                // SAFETY: each descriptor is open and owned by this process from here on.
                .map(|&descriptor| unsafe { OwnedFd::from_raw_fd(descriptor) })
                .collect()
        };
        // SAFETY: the array was allocated for the caller to free, and nothing reads it after.
        unsafe { libc::free(descriptors.cast()) };
        handed
            .into_iter()
            .next()
            .map(UnixListener::from)
            .ok_or_else(|| io::Error::other("launchd handed the wake helper no socket"))
    }

    // Whether a connection waits on `listener` within `wait`.
    fn is_connection_waiting(listener: &UnixListener, wait: Duration) -> io::Result<bool> {
        let mut waiting = libc::pollfd {
            fd: listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout = c_int::try_from(wait.as_millis()).unwrap_or(c_int::MAX);
        loop {
            // SAFETY: `waiting` is this frame's one entry, open for the call.
            let ready = unsafe { libc::poll(&raw mut waiting, 1, timeout) };
            if ready >= 0 {
                return Ok(ready > 0);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
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

    // The user at the Mac's screen, the owner of the console device; `None` while the login window
    // holds it as root.
    fn read_console_user() -> io::Result<Option<u32>> {
        let owner = fs::metadata(CONSOLE_DEVICE)?.uid();
        Ok((owner != 0).then_some(owner))
    }
}
