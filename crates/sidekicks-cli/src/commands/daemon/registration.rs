//! The service's registration to start at login, as the daemon commands use it: who owns it, its
//! install and its removal, behind one trait so a test can answer for the system's service manager;
//! a registration failure turned into the run's failure; and the line `daemon status` prints for it.

use std::path::Path;

use sidekicks_platforms::{
    ServiceInstall, ServiceOwner, ServiceRegistration, ServiceRegistrationError,
};

/// The line for a login agent the person turned off in Login Items, which `daemon status` prints
/// and a start fails with.
pub(crate) const TURNED_OFF_IN_LOGIN_ITEMS: &str = "The background service is installed but turned \
     off in System Settings › General › Login Items & Extensions.";

use crate::exit_codes::CommandFailure;

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
