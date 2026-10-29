//! The app's windowless start: the daemon starts the app's own program with no window, so it posts
//! the operating system's notification for a waiting entry while no app is open. The started
//! program exits at once when an app already runs, and becomes the windowed app when the person
//! opens it meanwhile; each platform's module starts it the way that platform starts an app.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::ExitStatus;

/// What a windowless start handed back: the started program's exit to watch, or nothing.
pub enum WindowlessLaunch {
    /// The started program, which outlives the daemon; its exit is answered once it has exited and
    /// been reaped, and fails with the system's error from the wait for its end or its reap.
    Watched {
        /// The started program's exit.
        exit: Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send>>,
    },
    /// The system started the program, or found it running, and handed back no process.
    Unwatched,
}
