//! The service's registration to start at login: which registration owns it, its install, its
//! start, its removal, whether the person turned it off, and whether a person is logged in at the
//! screen; and the system service that runs it while its account is logged out, behind an
//! administrator's password. Under `sudo` it acts for the account that ran `sudo`, never for root.
//! A system that registers the service supplies the registration in its own module; on any other
//! system the registration type has no value, so [`service_registration`] answers `None` there and
//! nothing else is called.

use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;

#[cfg(target_os = "macos")]
use crate::macos::administrator_prompt::AdministratorPromptError;

/// Which registration starts the service at login on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceOwner {
    /// The command line's own registration, which its install wrote.
    CommandLine,
    /// The app's registration: the system has the service loaded and the command line wrote no
    /// registration of its own.
    App,
    /// No registration: nothing starts the service at login, or this run's home is not the
    /// account's own, where no registered service could answer it.
    None,
}

/// Which account, if any, has the system service installed on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemServiceOwner {
    /// No system service is installed.
    NotInstalled,
    /// The installed system service runs the given program as this account.
    ThisAccount,
    /// The installed system service runs as this account but starts another program, so an
    /// install replaces it.
    ThisAccountOtherProgram,
    /// The installed system service runs as another account, or names none.
    OtherAccount,
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
    /// The system's service manager, or the program a root step runs, could not be started for a
    /// step.
    #[error("the program that runs the step to {step} could not be started")]
    Start {
        /// The step it was started for, such as `bootstrap`.
        step: &'static str,
        /// Why it could not start.
        #[source]
        source: io::Error,
    },
    /// The system's service manager, or the program a root step runs, refused a step: its exit
    /// status, which a caller may read, and what it wrote on its error stream.
    #[error("the service manager refused to {step} ({status}): {message}")]
    Refused {
        /// The refused step, such as `bootstrap`.
        step: &'static str,
        /// The service manager's exit status.
        status: ExitStatus,
        /// What it wrote on its error stream, trimmed.
        message: String,
    },
    /// The account this run acts for could not be read from the user database.
    #[error("this account's entry in the user database could not be read")]
    Account {
        /// Why it could not be read.
        #[source]
        source: io::Error,
    },
    /// The run has root's rights but names no other account it acts for: `sudo` was not used, it
    /// was used from root, or the account it names has no entry. Every step that acts for the
    /// account fails with it.
    #[error("running as root, but no account other than root ran sudo")]
    NoInvokingAccount,
    /// The person canceled the administrator password prompt.
    #[error("the administrator password was not given")]
    Canceled,
    /// The step run behind the administrator password prompt failed: the error number and message
    /// macOS answered, which for a failed command are its exit status and what it wrote on its
    /// error stream.
    #[error("the administrator step to {step} failed ({number}): {message}")]
    AdministratorRefused {
        /// The refused step, such as `install the system service`.
        step: &'static str,
        /// The error number macOS answered.
        number: i64,
        /// The message macOS answered, trimmed.
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
    /// The system answered a login item status this build does not know.
    #[error("the system answered the unknown login item status {value}")]
    UnknownLoginItemStatus {
        /// The status's number.
        value: isize,
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

#[cfg(target_os = "macos")]
impl From<AdministratorPromptError> for ServiceRegistrationError {
    fn from(failure: AdministratorPromptError) -> Self {
        match failure {
            AdministratorPromptError::Start { step, source } => Self::Start { step, source },
            AdministratorPromptError::Refused {
                step,
                status,
                message,
            } => Self::Refused {
                step,
                status,
                message,
            },
            AdministratorPromptError::Canceled => Self::Canceled,
            AdministratorPromptError::AdministratorRefused {
                step,
                number,
                message,
            } => Self::AdministratorRefused {
                step,
                number,
                message,
            },
        }
    }
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

    /// Whether the person turned the registration off; never called, since no value exists.
    pub fn is_turned_off(&self) -> Result<bool, ServiceRegistrationError> {
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

    /// Whether this run has root's rights; never called, since no value exists.
    pub fn runs_as_root(&self) -> bool {
        match *self {}
    }

    /// Which account has the system service installed; never called, since no value exists.
    pub fn system_service_owner(
        &self,
        _daemon_program: &std::path::Path,
    ) -> Result<SystemServiceOwner, ServiceRegistrationError> {
        match *self {}
    }

    /// Installs the system service; never called, since no value exists.
    pub async fn install_system_service(
        &self,
        _spawner: &crate::Spawner,
        _daemon_program: &std::path::Path,
        _is_app_installed: bool,
    ) -> Result<(), ServiceRegistrationError> {
        match *self {}
    }

    /// Removes the system service; never called, since no value exists.
    pub async fn uninstall_system_service(
        &self,
        _spawner: &crate::Spawner,
    ) -> Result<(), ServiceRegistrationError> {
        match *self {}
    }

    /// The account's home folder; never called, since no value exists.
    pub fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError> {
        match *self {}
    }

    /// Whether the login agent is loaded; never called, since no value exists.
    pub fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError> {
        match *self {}
    }

    /// Unloads the login agent; never called, since no value exists.
    pub fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError> {
        match *self {}
    }

    /// The command that runs a program as the account; never called, since no value exists.
    pub fn account_command(
        &self,
        _program: &std::path::Path,
    ) -> Result<std::process::Command, ServiceRegistrationError> {
        match *self {}
    }

    /// Why this build refuses the system service; never called, since no value exists.
    pub fn system_service_refusal(&self) -> Option<&'static str> {
        match *self {}
    }
}

/// The service's registration on this system: `None` here, where none is built, so the command
/// line offers no install or uninstall.
#[cfg(not(target_os = "macos"))]
pub fn service_registration() -> Option<ServiceRegistration> {
    None
}
