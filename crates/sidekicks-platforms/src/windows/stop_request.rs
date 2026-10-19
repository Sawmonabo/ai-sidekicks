//! The daemon's stop request on Windows: the console's Ctrl-C, and the end of the person's session
//! or the machine's shutdown, which Windows tells a program with no visible window only through
//! `WM_ENDSESSION` at a top-level window. A hidden window on a thread of its own answers
//! `WM_QUERYENDSESSION` at once and holds `WM_ENDSESSION` until the daemon's stop has run or four
//! seconds have passed, inside the five Windows gives such a program before it ends it.

use std::io;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use tokio::signal::windows::{CtrlC, ctrl_c};
use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassExW,
    TranslateMessage, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSEXW, WS_OVERLAPPED,
};

// The hidden window's class name.
const WINDOW_CLASS_NAME: &str = "ai-sidekicks-service-session-end";

// The answer to `WM_QUERYENDSESSION` that lets the session end.
const SESSION_MAY_END: LRESULT = 1;

// How long the window holds `WM_ENDSESSION` for the daemon's stop.
const SESSION_END_HOLD: Duration = Duration::from_secs(4);

// What the hidden window tells: the session's end, and where the daemon's finished stop is heard.
struct SessionEnd {
    requested: Arc<Notify>,
    stopped: Mutex<Option<Receiver<()>>>,
}

// The one hidden window's state, which its window procedure reads; set once per process.
static SESSION_END: OnceLock<SessionEnd> = OnceLock::new();

/// The stop request the daemon's start watches and its stop answers, held from
/// [`StopRequest::listen`] for the daemon's whole life; dropping it tells the hidden window the
/// stop has run, so the session may end.
pub struct StopRequest {
    ctrl_c: CtrlC,
    session_end: Arc<Notify>,
    stopped: SyncSender<()>,
}

impl StopRequest {
    /// Starts listening for Ctrl-C, from inside a tokio runtime, and opens the hidden window on a
    /// thread of its own. Fails when the console handler cannot be installed, the thread cannot
    /// start, or a stop request was already made in this process.
    pub fn listen() -> io::Result<Self> {
        let requested = Arc::new(Notify::new());
        let (stopped, stopped_heard) = mpsc::sync_channel(1);
        SESSION_END
            .set(SessionEnd {
                requested: Arc::clone(&requested),
                stopped: Mutex::new(Some(stopped_heard)),
            })
            .map_err(|_unset| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "a stop request was already made",
                )
            })?;
        let ctrl_c = ctrl_c()?;
        let (opened, opening) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("session-end-window".to_owned())
            .spawn(move || run_session_end_window(&opened))?;
        opening
            .recv()
            .map_err(|_closed| io::Error::other("the session-end window's thread ended"))??;
        Ok(Self {
            ctrl_c,
            session_end: requested,
            stopped,
        })
    }

    /// Waits for the next stop request: Ctrl-C or the session's end; also answers once the
    /// runtime is shutting down.
    pub async fn requested(&mut self) {
        tokio::select! {
            _ = self.ctrl_c.recv() => {}
            () = self.session_end.notified() => {}
        }
    }
}

impl Drop for StopRequest {
    fn drop(&mut self) {
        // A full channel already holds the word, and a closed one has no window left to tell.
        match self.stopped.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(()) | mpsc::TrySendError::Disconnected(())) => {}
        }
    }
}

// Registers the class, opens the hidden window and runs its messages until the process ends,
// telling `opened` whether the window opened.
fn run_session_end_window(opened: &SyncSender<io::Result<()>>) {
    let opening = open_session_end_window();
    let is_open = opening.is_ok();
    if let Err(unsent) = opened.send(opening) {
        drop(unsent);
    }
    if !is_open {
        return;
    }
    // SAFETY: `MSG` is a C struct of integers and pointers, for which all zero bytes are valid.
    let mut message: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: `message` is a live, writable `MSG`; a null window reads every message of this
    // thread, whose one window is the hidden one.
    while unsafe { GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        // SAFETY: `message` was just filled by `GetMessageW`.
        unsafe {
            TranslateMessage(&raw const message);
            DispatchMessageW(&raw const message);
        }
    }
}

// Registers the hidden window's class and opens it, never shown. Fails with the system's error.
fn open_session_end_window() -> io::Result<()> {
    let class_name: Vec<u16> = WINDOW_CLASS_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: a null name answers this program's own module, which needs no release.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(size_of::<WNDCLASSEXW>()).expect("the class's size fits a u32"),
        lpfnWndProc: Some(session_end_window_procedure),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `class` is a live, filled class whose name outlives the call.
    if unsafe { RegisterClassExW(&raw const class) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the class was just registered with this module; every pointer argument is the
    // class's name, which outlives the call, or null.
    let window = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// The hidden window's procedure: lets the session end, and at its end asks the daemon to stop and
// holds the message until the stop has run or the hold has passed.
unsafe extern "system" fn session_end_window_procedure(
    window: HWND,
    message: u32,
    word: WPARAM,
    long: LPARAM,
) -> LRESULT {
    match message {
        WM_QUERYENDSESSION => SESSION_MAY_END,
        WM_ENDSESSION => {
            if word != 0 {
                hold_for_the_stop();
            }
            0
        }
        // SAFETY: the arguments are the ones the system passed this procedure.
        _ => unsafe { DefWindowProcW(window, message, word, long) },
    }
}

// Asks the daemon to stop and waits for its stop to have run, at most the hold.
fn hold_for_the_stop() {
    let Some(session_end) = SESSION_END.get() else {
        return;
    };
    session_end.requested.notify_one();
    let stopped = session_end
        .stopped
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(stopped) = stopped {
        match stopped.recv_timeout(SESSION_END_HOLD) {
            Ok(()) | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
        }
    }
}
