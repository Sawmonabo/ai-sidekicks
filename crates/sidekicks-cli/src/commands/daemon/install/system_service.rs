//! `sidekicks daemon install --while-signed-out`: the system service that keeps the background
//! service running while the person is logged out takes the login agent's place. Where this build,
//! the screen or another account rules it out, the command refuses before it prints or changes
//! anything. Otherwise it says the secrets will be kept in files, stops the running service, moves
//! the secrets into their files, unloads the login agent and installs the system service behind
//! one administrator password; a step that fails puts each earlier one back before the command
//! refuses. The login agent's list is kept until the system service is in place, so putting the
//! agent back loads it again without writing it.

use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use sidekicks_client::daemon_ending::DaemonEndingVerb;
use sidekicks_contracts::daemon::secrets_place::{SECRETS_MOVE_MODE, SecretsMoveDestination};
use sidekicks_platforms::{
    CtrlCListener, ServiceOwner, ServiceRegistration, Spawner, SystemServiceOwner,
};
use tokio::runtime::Handle;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::install::wait_for_installed_daemon;
use crate::commands::daemon::registration::{
    RootStepFailure, read_owner, read_root_step_failure, registration_failure,
};
use crate::commands::data::offline_mode::run_offline_mode;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, ExitCode};

/// The line printed before anything changes, saying where the secrets will be kept.
const FILES_LINE: &str = "With this on, sign-ins and secrets are kept in files readable by this \
                          account alone, because a service that runs while you are logged out \
                          cannot reach the login keychain.\n";

/// The line for this account's system service already installed, with no login agent beside it.
const ALREADY_INSTALLED_LINE: &str =
    "The background service is already installed to run while you are logged out.\n";

/// The line for the system service installed and answering.
const INSTALLED_LINE: &str =
    "Installed the background service for this Mac. It runs while you are logged out.\n";

/// Why the service that runs while the person is logged out was not installed, in the words the
/// refusal's line ends with.
#[derive(Debug)]
pub(crate) enum LoggedOutServiceRefusal {
    /// This build refuses it, because a check of what macOS withholds from it failed: that cause.
    Probe(&'static str),
    /// This account has no session at the Mac's screen, where the password prompt is drawn.
    NoScreenSession,
    /// Another account on this Mac has the one system service installed.
    OtherAccount,
    /// The person canceled the administrator password prompt.
    PasswordNotGiven,
    /// macOS did not install it, with its own message.
    NotInstalled {
        /// macOS's message, or what could not be started.
        message: String,
    },
}

impl LoggedOutServiceRefusal {
    /// The exit code the refusal ends the run with: 77 for the password not given, 70 for an
    /// install macOS failed, and 78 where something must change first.
    pub(crate) const fn exit_code(&self) -> ExitCode {
        match self {
            Self::Probe(_) | Self::NoScreenSession | Self::OtherAccount => ExitCode::Configuration,
            Self::PasswordNotGiven => ExitCode::NoPermission,
            Self::NotInstalled { .. } => ExitCode::Software,
        }
    }
}

impl fmt::Display for LoggedOutServiceRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Probe(cause) => formatter.write_str(cause),
            Self::NoScreenSession => formatter.write_str(
                "turning it on needs this account logged in at the Mac's screen. Log in at this \
                 Mac, then run the command again",
            ),
            Self::OtherAccount => formatter.write_str(
                "another account on this Mac already has it on. Run sidekicks daemon uninstall \
                 from that account first",
            ),
            Self::PasswordNotGiven => {
                formatter.write_str("the administrator password was not given")
            }
            Self::NotInstalled { message } => {
                write!(formatter, "macOS did not install it ({message})")
            }
        }
    }
}

/// Installs the system service that runs the background service while the person is logged out
/// in place of the login agent, through `registration`, the service's program `daemon_path` or
/// the one beside this program, and answers 0 with the outcome's line on stdout. Fails with
/// [`CommandFailure::LoggedOutServiceRefused`] for each cause it refuses, with what it changed
/// put back first; with the moves mode's refusal when the secrets cannot move;
/// `ClientError::Canceled` after a Ctrl-C while the service stops; and as a read of the
/// registration, the service's stop, the login agent's removal or the wait for the installed
/// service fails.
pub(crate) fn install_while_signed_out<Output: Write, ErrorOutput: Write>(
    registration: ServiceRegistration,
    daemon_path: Option<&Path>,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    if let Some(cause) = registration.system_service_refusal() {
        return Err(refused(LoggedOutServiceRefusal::Probe(cause), Ok(())));
    }
    let has_screen_session = registration.has_screen_session().map_err(|failure| {
        registration_failure(failure, "could not read whether anyone is at the screen")
    })?;
    if !has_screen_session {
        return Err(refused(LoggedOutServiceRefusal::NoScreenSession, Ok(())));
    }
    let system_service_owner = registration.system_service_owner().map_err(|failure| {
        registration_failure(
            failure,
            "could not read which account runs the background service while logged out",
        )
    })?;
    if system_service_owner == SystemServiceOwner::OtherAccount {
        return Err(refused(LoggedOutServiceRefusal::OtherAccount, Ok(())));
    }
    let owner = read_owner(&registration)?;
    // A run whose home is not the account's own reads no agent, so it leaves the account's alone.
    let was_agent_loaded = owner != ServiceOwner::None
        && registration.is_agent_loaded().map_err(|failure| {
            registration_failure(failure, "could not read whether the login agent is loaded")
        })?;
    if system_service_owner == SystemServiceOwner::ThisAccount && !was_agent_loaded {
        context
            .stdout
            .write_all(ALREADY_INSTALLED_LINE.as_bytes())?;
        context.stdout.flush()?;
        return Ok(ExitCode::Success);
    }
    let program = daemon_program(daemon_path)?;
    context.stdout.write_all(FILES_LINE.as_bytes())?;
    context.stdout.flush()?;
    let takeover = Takeover {
        registration,
        owner,
        was_agent_loaded,
        program,
    };
    run_listening_for_ctrl_c(async |ctrl_c| takeover.run(ctrl_c).await)?;
    if owner == ServiceOwner::CommandLine {
        // Already unloaded, so only its list goes.
        registration.uninstall().map_err(|failure| {
            registration_failure(
                failure,
                "could not remove the login agent the service replaced",
            )
        })?;
    }
    wait_for_installed_daemon(&mut context.stderr)?;
    context.stdout.write_all(INSTALLED_LINE.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// The steps that put the system service in the login agent's place, and what puts them back.
struct Takeover {
    registration: ServiceRegistration,
    owner: ServiceOwner,
    was_agent_loaded: bool,
    program: PathBuf,
}

impl Takeover {
    /// Stops the running service, moves the secrets into their files, unloads the login agent and
    /// installs the system service; a later step's failure puts the earlier ones back first.
    async fn run(&self, ctrl_c: &mut CtrlCListener) -> anyhow::Result<()> {
        // A service that is not running is already stopped.
        end_running_daemon(
            DaemonEndingVerb::Stop,
            "could not stop the background service before replacing it",
            ctrl_c,
        )
        .await?;
        let moved = run_offline_mode(
            &self.program,
            secrets_move_arguments(SecretsMoveDestination::LoggedOutServiceFile),
        )
        .await;
        if let Err(refusal) = moved {
            // A refused move changed nothing, so only the stopped agent is started again.
            return Err(join_put_back(refusal, self.restore_agent().await));
        }
        if self.owner != ServiceOwner::None {
            let registration = self.registration;
            let booted_out = run_blocking(move || {
                registration.boot_out_agent().map_err(|failure| {
                    registration_failure(failure, "could not unload the login agent")
                })
            })
            .await;
            if let Err(failure) = booted_out {
                return Err(join_put_back(failure, self.put_back().await));
            }
        }
        let Err(failure) = self.install_system_service().await else {
            return Ok(());
        };
        let put_back = self.put_back().await;
        Err(match failure {
            InstallFailure::Refused(cause) => refused(cause, put_back),
            InstallFailure::Other(failure) => join_put_back(failure, put_back),
        })
    }

    /// Installs the system service behind the administrator password, attributed to the app where
    /// the app's agent ran the service, from a spawner thread that ends with the step.
    async fn install_system_service(&self) -> Result<(), InstallFailure> {
        let spawner = Spawner::new(Handle::current())
            .context("could not start the thread the administrator step runs from")
            .map_err(InstallFailure::Other)?;
        let installed = self
            .registration
            .install_system_service(&spawner, &self.program, self.owner == ServiceOwner::App)
            .await;
        let Err(failure) = installed else {
            return Ok(());
        };
        Err(
            match read_root_step_failure(failure, self.registration.runs_as_root()) {
                RootStepFailure::Canceled => {
                    InstallFailure::Refused(LoggedOutServiceRefusal::PasswordNotGiven)
                }
                RootStepFailure::NotDone { message } => {
                    InstallFailure::Refused(LoggedOutServiceRefusal::NotInstalled { message })
                }
                RootStepFailure::Other(failure) => InstallFailure::Other(registration_failure(
                    failure,
                    "could not install the background service to run while you are logged out",
                )),
            },
        )
    }

    /// Moves the secrets back into the login keychain, then puts the login agent back. Fails as
    /// the moves mode or [`Self::restore_agent`] does.
    async fn put_back(&self) -> anyhow::Result<()> {
        run_offline_mode(
            &self.program,
            secrets_move_arguments(SecretsMoveDestination::OperatingSystem),
        )
        .await
        .context("could not move the secrets back into the login keychain")?;
        self.restore_agent().await
    }

    /// Starts the login agent again where it was loaded: started where it is still loaded, and the
    /// command line's own kept list loaded again where it was unloaded. The app's agent, once
    /// unloaded, is loaded again by the app at its next start or the next login. Fails as the
    /// service manager does.
    async fn restore_agent(&self) -> anyhow::Result<()> {
        if !self.was_agent_loaded {
            return Ok(());
        }
        let registration = self.registration;
        let owner = self.owner;
        let program = self.program.clone();
        run_blocking(move || {
            let is_loaded = registration.is_agent_loaded().map_err(|failure| {
                registration_failure(failure, "could not read whether the login agent is loaded")
            })?;
            if is_loaded {
                registration.kickstart().map_err(|failure| {
                    registration_failure(failure, "could not start the login agent again")
                })?;
            } else if owner == ServiceOwner::CommandLine {
                registration.install(&program).map_err(|failure| {
                    registration_failure(failure, "could not load the login agent again")
                })?;
            }
            Ok(())
        })
        .await
    }
}

/// How the system service's install failed: a refusal the person is told as one, or any other
/// failure.
enum InstallFailure {
    Refused(LoggedOutServiceRefusal),
    Other(anyhow::Error),
}

/// The refusal for `cause`, carrying the failure of `put_back` where putting back failed.
fn refused(cause: LoggedOutServiceRefusal, put_back: anyhow::Result<()>) -> anyhow::Error {
    CommandFailure::LoggedOutServiceRefused {
        cause,
        put_back_failure: put_back.err().map(Into::into),
    }
    .into()
}

/// `failure`, with the failure of `put_back` above it where putting back failed, so the run still
/// ends with `failure`'s exit code.
fn join_put_back(failure: anyhow::Error, put_back: anyhow::Result<()>) -> anyhow::Error {
    match put_back {
        Ok(()) => failure,
        Err(put_back) => failure.context(format!(
            "could not put back what the command changed ({put_back:#}), after this failure"
        )),
    }
}

/// The moves mode's arguments that take the secrets to `destination`.
fn secrets_move_arguments(destination: SecretsMoveDestination) -> Vec<OsString> {
    SECRETS_MOVE_MODE
        .into_iter()
        .chain([destination.word()])
        .map(OsString::from)
        .collect()
}

/// Runs `step`, which blocks on the service manager, on a blocking thread.
async fn run_blocking<T: Send + 'static>(
    step: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(step)
        .await
        .context("a step on the service manager stopped before it answered")?
}
