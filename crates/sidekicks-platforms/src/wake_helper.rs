//! The machine's one wake helper, which wakes the computer from sleep a minute before a time the
//! service asks for: its booking and cancel, its install and removal behind one administrator
//! prompt, and its status. On macOS it is the root program `sidekicks-wake-helper`, installed at
//! `/Library/PrivilegedHelperTools/sidekicks-wake-helper` and started by launchd, from a legacy
//! property list in `/Library/LaunchDaemons`, when a connection reaches the socket
//! `/var/run/sidekicks-wake-helper.sock` that launchd holds for it, serving one line each way to
//! the user at the Mac's screen. A system that has a wake helper supplies it in its own module; on
//! any other system [`WakeHelper`] has no value, so [`wake_helper`] answers `None` there and
//! nothing else is called.

pub(crate) mod message;

use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;

use crate::code_signature::CodeSignatureError;

/// Whether the wake helper is in place to wake the computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeHelperStatus {
    /// Installed and allowed to run.
    Installed,
    /// Installed, but the person turned it off in the system's login items, so nothing wakes the
    /// computer.
    TurnedOff,
    /// Not installed, or its property list is gone.
    Missing,
}

/// Why a booking, a cancel, an install, a removal or a status read of the wake helper failed, with
/// its cause.
#[derive(Debug, thiserror::Error)]
pub enum WakeHelperError {
    /// The helper's socket could not be reached, or the exchange on it failed or timed out.
    #[error("the wake helper could not be reached")]
    Unreachable(#[source] io::Error),
    /// The helper answered a line that is no reply it writes.
    #[error("the wake helper answered something other than a reply: {line:?}")]
    UnknownReply {
        /// The line, trimmed.
        line: String,
    },
    /// The program that draws the administrator prompt could not be started.
    #[error("the administrator prompt could not be started to {step}")]
    Start {
        /// The step it was started for, such as `install the wake helper`.
        step: &'static str,
        /// Why it could not start.
        #[source]
        source: io::Error,
    },
    /// The program that draws the administrator prompt failed itself: its exit status and what it
    /// wrote on its error stream.
    #[error("the administrator prompt failed to {step} ({status}): {message}")]
    Refused {
        /// The step, such as `install the wake helper`.
        step: &'static str,
        /// Its exit status.
        status: ExitStatus,
        /// What it wrote on its error stream, trimmed.
        message: String,
    },
    /// The person canceled the administrator prompt.
    #[error("the administrator password was not given")]
    Canceled,
    /// The step run behind the administrator prompt failed: the error number and message the
    /// system answered, which for a failed command are its exit status and its error stream.
    #[error("the administrator step to {step} failed ({number}): {message}")]
    AdministratorRefused {
        /// The step, such as `install the wake helper`.
        step: &'static str,
        /// The error number the system answered.
        number: i64,
        /// The message the system answered, trimmed.
        message: String,
    },
    /// A file the install or the status read needs could not be written or read.
    #[error("{} could not be written or read", path.display())]
    File {
        /// The file.
        path: PathBuf,
        /// Why.
        #[source]
        source: io::Error,
    },
    /// This program's own signature, whose team the helper's install checks the helper against,
    /// could not be read.
    #[error("this program's signature, which the wake helper's is checked against, did not read")]
    Signature(#[source] CodeSignatureError),
    /// The system answered a login item status this build does not know.
    #[error("the system answered the unknown login item status {value}")]
    UnknownStatus {
        /// The status's number.
        value: isize,
    },
}

/// The wake helper on a system with none built: the type has no value, so no method is ever
/// called.
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, Debug)]
pub enum WakeHelper {}

#[cfg(not(target_os = "macos"))]
impl WakeHelper {
    /// Books a wake; never called, since no value exists.
    pub async fn book(
        &self,
        _asked_at: std::time::SystemTime,
    ) -> Result<message::WakeReply, WakeHelperError> {
        match *self {}
    }

    /// Cancels a wake; never called, since no value exists.
    pub async fn cancel(
        &self,
        _asked_at: std::time::SystemTime,
    ) -> Result<message::WakeReply, WakeHelperError> {
        match *self {}
    }

    /// Installs the helper; never called, since no value exists.
    pub async fn install(
        &self,
        _spawner: &crate::Spawner,
        _helper_program: &std::path::Path,
    ) -> Result<(), WakeHelperError> {
        match *self {}
    }

    /// Removes the helper; never called, since no value exists.
    pub async fn uninstall(&self, _spawner: &crate::Spawner) -> Result<(), WakeHelperError> {
        match *self {}
    }

    /// The helper's status; never called, since no value exists.
    pub fn status(&self) -> Result<WakeHelperStatus, WakeHelperError> {
        match *self {}
    }
}

/// The wake helper on this system: `None` here, where none is built.
#[cfg(not(target_os = "macos"))]
pub fn wake_helper() -> Option<WakeHelper> {
    None
}
