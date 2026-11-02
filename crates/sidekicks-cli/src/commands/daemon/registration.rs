//! The service's registration to start at login, as the daemon commands use it: who owns it, its
//! install and its removal, behind one trait so a test can answer for the system's service
//! manager; a registration failure turned into the run's failure; this program run again as the
//! account from a run with root's rights; and the line `daemon status` prints for it, this
//! account's system service that runs while the person is logged out read before the login agent.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context as _;
use sidekicks_platforms::{
    ServiceInstall, ServiceOwner, ServiceRegistration, ServiceRegistrationError,
    SystemServiceOwner, wait_through_ctrl_c,
};

use crate::daemon_program::this_program;
use crate::exit_codes::{CommandFailure, ExitCode};

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

/// Runs this program with `arguments` as the account through `registration`, on this run's
/// terminal, its standard output to `output`, and answers the exit code it ended with. A Ctrl-C
/// ends only that run, which this one waits out, so the shell's prompt comes back once it has
/// finished. Fails when this program or the account cannot be named or the run cannot start or be
/// waited for, and with `ClientError::Canceled` for a run a Ctrl-C ended.
pub(crate) fn run_as_account(
    registration: ServiceRegistration,
    arguments: impl IntoIterator<Item = impl AsRef<OsStr>>,
    output: Stdio,
) -> anyhow::Result<ExitCode> {
    let (program, mut command) =
        this_program_as_account(|program| registration.account_command(program))?;
    let mut child = command
        .args(arguments)
        .stdout(output)
        .spawn()
        .with_context(|| format!("could not run {} as this account", program.display()))?;
    let status = wait_through_ctrl_c(&mut child).with_context(|| {
        format!(
            "could not wait for {}, run as this account, to end",
            program.display()
        )
    })?;
    ExitCode::of_program_run(status)
}

/// `failure` of a read in the account's home under root's rights, a refused permission read as
/// [`CommandFailure::HomeUnreadable`], whose line says what to do in its place, as on a network
/// home `sudo` cannot read.
pub(crate) fn read_home_refusal(failure: anyhow::Error) -> anyhow::Error {
    let is_permission_refused = failure.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
    });
    if is_permission_refused {
        return CommandFailure::HomeUnreadable.into();
    }
    failure
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
    /// This account's system service runs it while the person is logged out.
    SystemService {
        /// Whether the person turned the system service off in Login Items.
        is_turned_off: bool,
    },
}

impl LoginStart {
    /// The status line for this, given whether the service answers.
    pub(crate) const fn line(self, is_answering: bool) -> &'static str {
        match (self, is_answering) {
            (Self::NotInstalled, _) => "The background service is not installed.",
            (
                Self::TurnedOff
                | Self::SystemService {
                    is_turned_off: true,
                },
                _,
            ) => TURNED_OFF_IN_LOGIN_ITEMS,
            (Self::Installed, true) => "The background service is running and starts at login.",
            (Self::Installed, false) => {
                "The background service is installed and starts at login, but is not running."
            }
            (
                Self::SystemService {
                    is_turned_off: false,
                },
                true,
            ) => "The background service is running and keeps running while you are logged out.",
            (
                Self::SystemService {
                    is_turned_off: false,
                },
                false,
            ) => {
                "The background service is installed to keep running while you are logged out, \
                 but is not running."
            }
        }
    }

    /// Whether the person turned the registration that starts the service off in Login Items.
    pub(crate) const fn is_turned_off(self) -> bool {
        matches!(
            self,
            Self::TurnedOff
                | Self::SystemService {
                    is_turned_off: true
                }
        )
    }
}

/// Whether the service starts through `registration`: this account's system service first, and
/// whether the person turned it off; else the login agent's owner, and for the command line's own
/// agent whether the person turned it off. Fails as any of these reads does.
pub(crate) fn read_login_start(
    registration: ServiceRegistration,
) -> Result<LoginStart, ServiceRegistrationError> {
    match registration.system_service_owner(None)? {
        SystemServiceOwner::ThisAccount | SystemServiceOwner::ThisAccountOtherProgram => {
            return Ok(LoginStart::SystemService {
                is_turned_off: registration.is_system_service_turned_off()?,
            });
        }
        SystemServiceOwner::NotInstalled | SystemServiceOwner::OtherAccount => {}
    }
    Ok(match registration.owner()? {
        ServiceOwner::None => LoginStart::NotInstalled,
        ServiceOwner::CommandLine if registration.is_turned_off()? => LoginStart::TurnedOff,
        ServiceOwner::CommandLine | ServiceOwner::App => LoginStart::Installed,
    })
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::read_home_refusal;
    use crate::exit_codes::CommandFailure;

    // Fails when a refused permission anywhere in the chain is not read as the unreadable home
    // (the first case keeps the file's error), and when every failure is (the second case's own
    // error is lost).
    #[test]
    fn only_a_refused_permission_reads_as_an_unreadable_home() {
        let refused = anyhow::Error::new(io::Error::from(io::ErrorKind::PermissionDenied))
            .context("could not read where the secrets are kept");
        let missing = anyhow::Error::new(io::Error::from(io::ErrorKind::NotFound))
            .context("could not read where the secrets are kept");

        let refused = read_home_refusal(refused);
        let missing = read_home_refusal(missing);

        assert!(matches!(
            refused.downcast_ref::<CommandFailure>(),
            Some(CommandFailure::HomeUnreadable)
        ));
        assert!(missing.downcast_ref::<CommandFailure>().is_none());
        assert_eq!(
            missing.to_string(),
            "could not read where the secrets are kept"
        );
    }
}
