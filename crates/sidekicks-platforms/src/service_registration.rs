//! The service's registration to start at login: which registration owns it, its install, its
//! start, its removal, and whether a person is logged in at the screen. A system that registers
//! the service supplies the registration in its own module; on any other system the registration
//! type has no value, so [`service_registration`] answers `None` there and nothing else is called.

use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;

/// Which registration starts the service at login on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceOwner {
    /// The command line's own registration, which its install wrote.
    CommandLine,
    /// The app's registration: the system has the service loaded and the command line wrote no
    /// registration of its own.
    App,
    /// No registration: nothing starts the service at login.
    None,
}

/// What an install did, which decides what the person is told.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceInstall {
    /// The registration already named this program and was loaded, so nothing changed.
    Unchanged,
    /// The registration is in place and loaded into the login session, which started the service.
    Loaded,
    /// The registration is in place, but no one is logged in at the screen, so the system loads
    /// it and starts the service at the next login there.
    AtNextLogin,
}

/// Why reading, installing, starting or removing the service's registration failed, with its
/// cause.
#[derive(Debug, thiserror::Error)]
pub enum ServiceRegistrationError {
    /// The account has no home folder, where the registration's file lives.
    #[error("this account has no home folder")]
    NoHomeFolder,
    /// The system's service manager could not be started for a step.
    #[error("the service manager could not be started to {step}")]
    Start {
        /// The step it was started for, such as `bootstrap`.
        step: &'static str,
        /// Why it could not start.
        #[source]
        source: io::Error,
    },
    /// The system's service manager refused a step: its exit status, which a caller may read, and
    /// what it wrote on its error stream.
    #[error("the service manager refused to {step} ({status}): {message}")]
    Refused {
        /// The refused step, such as `bootstrap`.
        step: &'static str,
        /// The service manager's exit status.
        status: ExitStatus,
        /// What it wrote on its error stream, trimmed.
        message: String,
    },
    /// The registration's file could not be read or understood.
    #[error("the service's registration at {} could not be read", path.display())]
    Read {
        /// The registration's file.
        path: PathBuf,
        /// Why it could not be read.
        #[source]
        source: io::Error,
    },
    /// The registration's file, or the folder it lives in, could not be written.
    #[error("the service's registration at {} could not be written", path.display())]
    Write {
        /// The registration's file.
        path: PathBuf,
        /// Why it could not be written.
        #[source]
        source: io::Error,
    },
    /// The registration's file could not be removed.
    #[error("the service's registration at {} could not be removed", path.display())]
    Remove {
        /// The registration's file.
        path: PathBuf,
        /// Why it could not be removed.
        #[source]
        source: io::Error,
    },
}

/// The service's registration on a system with none built: the type has no value, so no method is
/// ever called.
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, Debug)]
pub enum ServiceRegistration {}

#[cfg(not(target_os = "macos"))]
impl ServiceRegistration {
    /// Which registration starts the service at login; never called, since no value exists.
    pub fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
        match *self {}
    }

    /// Installs the registration; never called, since no value exists.
    pub fn install(
        &self,
        _daemon_program: &std::path::Path,
    ) -> Result<ServiceInstall, ServiceRegistrationError> {
        match *self {}
    }

    /// Starts the registered service; never called, since no value exists.
    pub fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
        match *self {}
    }

    /// Removes the registration; never called, since no value exists.
    pub fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
        match *self {}
    }

    /// Whether a person is logged in at the screen; never called, since no value exists.
    pub fn has_screen_session(&self) -> Result<bool, ServiceRegistrationError> {
        match *self {}
    }
}

/// The service's registration on this system: `None` here, where none is built, so the command
/// line offers no install or uninstall.
#[cfg(not(target_os = "macos"))]
pub fn service_registration() -> Option<ServiceRegistration> {
    None
}
