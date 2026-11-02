//! The service's registration to start at login, as the daemon commands use it: who owns it, its
//! install and its removal, behind one trait so a test can answer for the system's service
//! manager; a registration failure turned into the run's failure; and the line `daemon status`
//! prints for it.

use std::path::{Path, PathBuf};
use std::process::Command;

use sidekicks_platforms::{
    ServiceInstall, ServiceOwner, ServiceRegistration, ServiceRegistrationError,
};

use crate::daemon_program::this_program;
use crate::exit_codes::CommandFailure;

/// The line for a login agent the person turned off in Login Items, which `daemon status` prints
/// and a start fails with.
pub(crate) const TURNED_OFF_IN_LOGIN_ITEMS: &str = "The background service is installed but turned \
     off in System Settings › General › Login Items & Extensions.";

/// The steps of the service's registration the install and uninstall commands take.
pub(crate) trait LoginRegistration {
    /// Which registration starts the service at login; fails when it cannot be read.
    fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError>;

    /// Installs the command line's registration starting `daemon_program`, and answers what that
    /// did; fails with the step that failed.
    fn install(&self, daemon_program: &Path) -> Result<ServiceInstall, ServiceRegistrationError>;

    /// Removes the command line's registration; fails with the step that failed.
    fn uninstall(&self) -> Result<(), ServiceRegistrationError>;
}

impl LoginRegistration for ServiceRegistration {
    fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
        ServiceRegistration::owner(self)
    }

    fn install(&self, daemon_program: &Path) -> Result<ServiceInstall, ServiceRegistrationError> {
        ServiceRegistration::install(self, daemon_program)
    }

    fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::uninstall(self)
    }
}

/// Refuses an install or uninstall through `registration` with
/// [`CommandFailure::NotAccountHome`] when `$HOME` is not the account's home, since the account's
/// login session it acts on would then serve a home its service never answers in. Fails too when
/// the home cannot be read.
pub(crate) fn refuse_other_home(registration: ServiceRegistration) -> anyhow::Result<()> {
    let is_account_home = registration.is_account_home().map_err(|failure| {
        registration_failure(failure, "could not read whether HOME is your home folder")
    })?;
    if !is_account_home {
        return Err(CommandFailure::NotAccountHome.into());
    }
    Ok(())
}

/// This program's own file, and the command that runs it as the account through
/// `account_command`. Fails when this program or the account cannot be named.
pub(crate) fn this_program_as_account(
    account_command: impl FnOnce(&Path) -> Result<Command, ServiceRegistrationError>,
) -> anyhow::Result<(PathBuf, Command)> {
    let program = this_program()?;
    let command = account_command(&program).map_err(|failure| {
        registration_failure(failure, "could not name the account to run this program as")
    })?;
    Ok((program, command))
}

/// `failure` as the run's failure: a step the service manager refused as
/// [`CommandFailure::RegistrationRefused`], with its message as the cause; any other with `doing`
/// as its context.
pub(crate) fn registration_failure(
    failure: ServiceRegistrationError,
    doing: &'static str,
) -> anyhow::Error {
    if matches!(failure, ServiceRegistrationError::Refused { .. }) {
        return CommandFailure::RegistrationRefused(failure).into();
    }
    anyhow::Error::new(failure).context(doing)
}

/// How a step run as root failed, as the person is told it.
pub(crate) enum RootStepFailure {
    /// The person canceled the administrator password prompt.
    Canceled,
    /// The step ran and failed, or its program could not run: macOS's own message, or what could
    /// not be started.
    NotDone {
        /// The message, in macOS's words where it gave one.
        message: String,
    },
    /// A failure before the step ran, such as the account's read.
    Other(ServiceRegistrationError),
}

/// `failure` of a step run as root, behind the administrator password prompt unless the run
/// `runs_as_root`, read for what the person is told.
pub(crate) fn read_root_step_failure(
    failure: ServiceRegistrationError,
    runs_as_root: bool,
) -> RootStepFailure {
    match failure {
        ServiceRegistrationError::Canceled => RootStepFailure::Canceled,
        ServiceRegistrationError::AdministratorRefused {
            number, message, ..
        } => RootStepFailure::NotDone {
            message: if message.is_empty() {
                format!("error {number}")
            } else {
                message
            },
        },
        ServiceRegistrationError::Refused {
            status, message, ..
        } => RootStepFailure::NotDone {
            message: if message.is_empty() {
                status.to_string()
            } else {
                message
            },
        },
        ServiceRegistrationError::Start { source, .. } => {
            let program = if runs_as_root {
                "the shell that runs it as root"
            } else {
                "the administrator password prompt"
            };
            RootStepFailure::NotDone {
                message: format!("{program} could not be started: {source}"),
            }
        }
        failure @ (ServiceRegistrationError::NoHomeFolder
        | ServiceRegistrationError::Account { .. }
        | ServiceRegistrationError::NoInvokingAccount
        | ServiceRegistrationError::Read { .. }
        | ServiceRegistrationError::Write { .. }
        | ServiceRegistrationError::UnknownLoginItemStatus { .. }
        | ServiceRegistrationError::Remove { .. }) => RootStepFailure::Other(failure),
    }
}

/// Which registration starts the service at login, read through `registration`. Fails as
/// [`registration_failure`] turns the read's failure.
pub(crate) fn read_owner(registration: &impl LoginRegistration) -> anyhow::Result<ServiceOwner> {
    registration.owner().map_err(|failure| {
        registration_failure(
            failure,
            "could not read what runs the background service at login",
        )
    })
}

/// Whether the service starts at login, as `daemon status` reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoginStart {
    /// No registration starts it.
    NotInstalled,
    /// The command line's own login agent, which the person turned off in Login Items.
    TurnedOff,
    /// The command line's or the app's login agent starts it.
    Installed,
}

impl LoginStart {
    /// The status line for this, given whether the service answers.
    pub(crate) const fn line(self, is_answering: bool) -> &'static str {
        match (self, is_answering) {
            (Self::NotInstalled, _) => "The background service is not installed.",
            (Self::TurnedOff, _) => TURNED_OFF_IN_LOGIN_ITEMS,
            (Self::Installed, true) => "The background service is running and starts at login.",
            (Self::Installed, false) => {
                "The background service is installed and starts at login, but is not running."
            }
        }
    }
}

/// Whether the service starts at login through `registration`: its owner, and for the command
/// line's own agent whether the person turned it off. Fails as either read does.
pub(crate) fn read_login_start(
    registration: ServiceRegistration,
) -> Result<LoginStart, ServiceRegistrationError> {
    Ok(match registration.owner()? {
        ServiceOwner::None => LoginStart::NotInstalled,
        ServiceOwner::CommandLine if registration.is_turned_off()? => LoginStart::TurnedOff,
        ServiceOwner::CommandLine | ServiceOwner::App => LoginStart::Installed,
    })
}
