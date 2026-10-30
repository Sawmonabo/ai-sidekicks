//! The service's registration to start at login, as `daemon install` and `daemon uninstall` use
//! it: who owns it, its install and its removal, behind one trait so a test can answer for the
//! system's service manager, and a registration failure turned into the run's failure.

use std::path::Path;

use sidekicks_platforms::{
    ServiceInstall, ServiceOwner, ServiceRegistration, ServiceRegistrationError,
};

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
