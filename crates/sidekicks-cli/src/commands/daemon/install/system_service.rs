//! `sidekicks daemon install --while-signed-out`: the system service that keeps the background
//! service running while the person is logged out takes the login agent's place. Where this build,
//! the screen or another account rules it out, the command refuses before it prints or changes
//! anything. Otherwise it says the secrets will be kept in files, stops the running service, moves
//! the secrets into their files, unloads the login agent and installs the system service behind
//! one administrator password; a step that fails puts each earlier one back before the command
//! refuses. The login agent's list is kept until the system service is in place, so putting the
//! agent back loads it again without writing it.
//!
//! Run under `sudo`, as over SSH with no one at the screen, it acts for the account that ran
//! `sudo` and writes nothing in that account's data folder: it refuses while the record there
//! names the login keychain, which root cannot reach, or while a service neither the login agent
//! nor this account's system service runs holds the folder; otherwise it unloads the login agent,
//! which ends its service, and installs the system service directly.

use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use sidekicks_client::daemon_ending::{DaemonEnd, DaemonEndingVerb};
use sidekicks_contracts::daemon::data::{
    DAEMON_DATA_FOLDER_NAME, DAEMON_LOCK_FILE_NAME, DAEMON_PROCESS_ID_FILE_NAME,
};
use sidekicks_contracts::daemon::lifecycle::SYSTEM_SERVICE_MODE;
use sidekicks_contracts::daemon::secrets_place::{
    PlaceRecord, SECRETS_MOVE_MODE, SecretsMoveDestination,
};
use sidekicks_platforms::{
    CtrlCListener, ServiceOwner, ServiceRegistration, ServiceRegistrationError, Spawner,
    SystemServiceOwner, read_process_start,
};
use tokio::runtime::Handle;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::install::wait_for_installed_daemon;
use crate::commands::daemon::registration::{
    LoginRegistration, RootStepFailure, read_home_refusal, read_owner, read_root_step_failure,
    registration_failure,
};
use crate::commands::daemon::secrets_place::read_secrets_place;
use crate::commands::data::offline_mode::run_offline_mode;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, ExitCode};

/// The line printed before anything changes, saying where the secrets will be kept.
const FILES_LINE: &str = "With this on, sign-ins and secrets are kept in files readable by this \
                          account alone, because a service that runs while you are logged out \
                          cannot reach the login keychain.\n";

/// The warning for a service no login agent ran, stopped for a takeover that then failed, which
/// nothing starts again.
const LASTING_SERVICE_STOPPED_LINE: &str = "warning: the background service was stopped and stays stopped. Start it again with sidekicks \
     daemon start.\n";

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
    /// The secrets are in the login keychain, which a run under `sudo` cannot reach to move them.
    KeychainHoldsSecrets,
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
            Self::Probe(_)
            | Self::NoScreenSession
            | Self::OtherAccount
            | Self::KeychainHoldsSecrets => ExitCode::Configuration,
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
            Self::KeychainHoldsSecrets => formatter.write_str(
                "the sign-ins and secrets are in the login keychain. Log in at this Mac once, run \
                 the command there, then it runs while you are logged out",
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

/// The steps of the service's registration the logged-out install takes, beside the login
/// agent's, behind one trait so a test can answer for the system's service manager.
pub(crate) trait LoggedOutServiceRegistration: LoginRegistration {
    /// Which account has the system service installed, and whether it starts `daemon_program`
    /// where one is given; fails when it cannot be read.
    fn system_service_owner(
        &self,
        daemon_program: Option<&Path>,
    ) -> Result<SystemServiceOwner, ServiceRegistrationError>;

    /// Whether the login agent is loaded; fails when it cannot be read.
    fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError>;

    /// Unloads the login agent, waiting for its service to exit; fails with the step's refusal.
    fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError>;

    /// Starts the loaded login agent; fails with the step's refusal.
    fn kickstart(&self) -> Result<(), ServiceRegistrationError>;

    /// Loads the command line's own login agent from its kept list, as it is; fails with the
    /// step's refusal.
    fn bootstrap_agent(&self) -> Result<(), ServiceRegistrationError>;

    /// The account's home folder; fails when it cannot be read.
    fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError>;

    /// Whether this run has root's rights, as under `sudo`.
    fn runs_as_root(&self) -> bool;

    /// Installs the system service starting `daemon_program`, attributed to the app when
    /// `is_attributed_to_app`, its root step started on `spawner`'s thread; fails with the step's
    /// cause.
    async fn install_system_service(
        &self,
        spawner: &Spawner,
        daemon_program: &Path,
        is_attributed_to_app: bool,
    ) -> Result<(), ServiceRegistrationError>;
}

impl LoggedOutServiceRegistration for ServiceRegistration {
    fn system_service_owner(
        &self,
        daemon_program: Option<&Path>,
    ) -> Result<SystemServiceOwner, ServiceRegistrationError> {
        ServiceRegistration::system_service_owner(self, daemon_program)
    }

    fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError> {
        ServiceRegistration::is_agent_loaded(self)
    }

    fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::boot_out_agent(self)
    }

    fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::kickstart(self)
    }

    fn bootstrap_agent(&self) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::bootstrap_agent(self)
    }

    fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError> {
        ServiceRegistration::account_home(self)
    }

    fn runs_as_root(&self) -> bool {
        ServiceRegistration::runs_as_root(self)
    }

    async fn install_system_service(
        &self,
        spawner: &Spawner,
        daemon_program: &Path,
        is_attributed_to_app: bool,
    ) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::install_system_service(
            self,
            spawner,
            daemon_program,
            is_attributed_to_app,
        )
        .await
    }
}

/// Installs the system service that runs the background service while the person is logged out
/// in place of the login agent, through `registration`, the service's program `daemon_path` or
/// the one beside this program, and answers 0 with the outcome's line on stdout; under `sudo` as
/// [`install_as_root`] does. Fails with [`CommandFailure::LoggedOutServiceRefused`] for each cause
/// it refuses, with what it changed put back first; with the moves mode's refusal when the secrets
/// cannot move; `ClientError::Canceled` after a Ctrl-C while the service stops; and as a read of
/// the registration, the service's stop, the login agent's removal or the wait for the installed
/// service, within `deadline`, fails.
pub(crate) fn install_while_signed_out<Output: Write, ErrorOutput: Write>(
    registration: ServiceRegistration,
    daemon_path: Option<&Path>,
    deadline: Duration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    if let Some(cause) = registration.system_service_refusal() {
        return Err(refused(LoggedOutServiceRefusal::Probe(cause), Ok(())));
    }
    if registration.runs_as_root() {
        return install_as_root(&registration, daemon_path, context);
    }
    let has_screen_session = registration.has_screen_session().map_err(|failure| {
        registration_failure(failure, "could not read whether anyone is at the screen")
    })?;
    if !has_screen_session {
        return Err(refused(LoggedOutServiceRefusal::NoScreenSession, Ok(())));
    }
    let program = daemon_program(daemon_path)?;
    let Goal::Takeover {
        owner,
        was_agent_loaded,
        ..
    } = read_goal(&registration, &program)?
    else {
        return write_line(context, ALREADY_INSTALLED_LINE);
    };
    context.stdout.write_all(FILES_LINE.as_bytes())?;
    context.stdout.flush()?;
    let takeover = Takeover {
        registration,
        owner,
        was_agent_loaded,
        program,
    };
    let mut is_lasting_service_stopped = false;
    let taken = run_listening_for_ctrl_c(async |ctrl_c| {
        takeover.run(ctrl_c, &mut is_lasting_service_stopped).await
    });
    if taken.is_err() && is_lasting_service_stopped {
        context
            .stderr
            .write_all(LASTING_SERVICE_STOPPED_LINE.as_bytes())?;
    }
    taken?;
    remove_replaced_agent(&registration, owner)?;
    wait_for_installed_daemon(&mut context.stderr, deadline)?;
    write_line(context, INSTALLED_LINE)
}

/// Installs the system service under `sudo`, for the account that ran it, through `registration`
/// and the service's program `daemon_path` or the one beside this program, and answers 0 with the
/// outcome's line on stdout. Writes nothing in the account's data folder and runs no moves mode,
/// so it refuses with [`LoggedOutServiceRefusal::KeychainHoldsSecrets`] while the record there
/// names the login keychain, with [`CommandFailure::HomeUnreadable`] where root cannot
/// read the account's home, and with [`CommandFailure::DataFolderHeld`] while a service neither
/// the login agent nor this account's system service runs holds the folder. Otherwise it unloads
/// the login agent, which ends its service, installs the system service and removes the command
/// line's agent list; root cannot pass the service's own-account check, so it does not wait for
/// the service to answer. Fails as the reads, the record, the lock's probe, the unload or the
/// install fails, with the login agent put back first after the unload.
fn install_as_root<Output: Write, ErrorOutput: Write>(
    registration: &impl LoggedOutServiceRegistration,
    daemon_path: Option<&Path>,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let program = daemon_program(daemon_path)?;
    let Goal::Takeover {
        system_service_owner,
        owner,
        was_agent_loaded,
    } = read_goal(registration, &program)?
    else {
        return write_line(context, ALREADY_INSTALLED_LINE);
    };
    let home = registration
        .account_home()
        .map_err(|failure| registration_failure(failure, "could not read this account's home"))?;
    let place = read_secrets_place(&home).map_err(read_home_refusal)?;
    if place.is_some_and(PlaceRecord::names_operating_system) {
        return Err(refused(
            LoggedOutServiceRefusal::KeychainHoldsSecrets,
            Ok(()),
        ));
    }
    // A loaded agent's service, or this account's system service, holds the lock, and the agent's
    // unload or the install's own unload of the system service frees it; any other holder, a
    // service started by hand among them, refuses the install.
    let data_folder = home.join(DAEMON_DATA_FOLDER_NAME);
    if !was_agent_loaded
        && is_data_folder_held(&data_folder).map_err(read_home_refusal)?
        && (system_service_owner == SystemServiceOwner::NotInstalled
            || !is_system_service_holding(&data_folder).map_err(read_home_refusal)?)
    {
        return Err(CommandFailure::DataFolderHeld.into());
    }
    context.stdout.write_all(FILES_LINE.as_bytes())?;
    context.stdout.flush()?;
    if let Err(failure) = registration.boot_out_agent() {
        let put_back = restore_agent_steps(registration, owner, was_agent_loaded);
        return Err(join_put_back(
            registration_failure(failure, "could not unload the login agent"),
            put_back,
        ));
    }
    let installed = run_listening_for_ctrl_c(async |_ctrl_c| {
        Ok(install_system_service(registration, &program, owner).await)
    })?;
    if let Err(failure) = installed {
        let put_back = restore_agent_steps(registration, owner, was_agent_loaded);
        return Err(match failure {
            InstallFailure::Refused(cause) => refused(cause, put_back),
            InstallFailure::Other(failure) => join_put_back(failure, put_back),
        });
    }
    remove_replaced_agent(registration, owner)?;
    write_line(context, INSTALLED_LINE)
}

/// What the logged-out install found before it changes anything.
enum Goal {
    /// This account's system service already starts this program, with no login agent beside it.
    Holds,
    /// The system service is to take the place of what runs the service now.
    Takeover {
        /// Which account's system service is installed, and at which program.
        system_service_owner: SystemServiceOwner,
        /// Which registration starts the service at login.
        owner: ServiceOwner,
        /// Whether the login agent was loaded.
        was_agent_loaded: bool,
    },
}

/// Whether the system service already runs `program` for this account through `registration`,
/// else what it is to replace. Fails with [`LoggedOutServiceRefusal::OtherAccount`] when another
/// account has it installed, and as the registration's reads fail.
fn read_goal(
    registration: &impl LoggedOutServiceRegistration,
    program: &Path,
) -> anyhow::Result<Goal> {
    let system_service_owner = read_system_service_owner(registration, Some(program))?;
    if system_service_owner == SystemServiceOwner::OtherAccount {
        return Err(refused(LoggedOutServiceRefusal::OtherAccount, Ok(())));
    }
    let owner = read_owner(registration)?;
    // A run whose home is not the account's own reads no agent, so it leaves the account's alone.
    let was_agent_loaded = owner != ServiceOwner::None
        && registration.is_agent_loaded().map_err(|failure| {
            registration_failure(failure, "could not read whether the login agent is loaded")
        })?;
    if system_service_owner == SystemServiceOwner::ThisAccount && !was_agent_loaded {
        return Ok(Goal::Holds);
    }
    Ok(Goal::Takeover {
        system_service_owner,
        owner,
        was_agent_loaded,
    })
}

/// Which account has the system service installed, read through `registration`, and for this
/// account whether it starts `daemon_program` where one is given. Fails as
/// [`registration_failure`] turns the read's failure.
pub(crate) fn read_system_service_owner(
    registration: &impl LoggedOutServiceRegistration,
    daemon_program: Option<&Path>,
) -> anyhow::Result<SystemServiceOwner> {
    registration
        .system_service_owner(daemon_program)
        .map_err(|failure| {
            registration_failure(
                failure,
                "could not read which account runs the background service while logged out",
            )
        })
}

/// Whether a service holds the data folder at `data_folder`: its lock file locked, read through a
/// shared lock tried once on the file opened read only, which neither creates nor changes it. A
/// folder with no lock file is not held. Fails, naming the file, when it cannot be opened or
/// locked.
fn is_data_folder_held(data_folder: &Path) -> anyhow::Result<bool> {
    let path = data_folder.join(DAEMON_LOCK_FILE_NAME);
    let unreadable = |failure: io::Error| {
        anyhow::Error::new(failure).context(format!(
            "could not read whether a background service holds {}",
            path.display()
        ))
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(unreadable(failure)),
    };
    // The probe's shared lock is freed as the file closes on return.
    match file.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(failure)) => Err(unreadable(failure)),
    }
}

/// Whether the holder of the data folder at `data_folder` is this account's system service: the
/// process whose id its holder wrote beside the lock runs the daemon's system service mode. A
/// missing or unreadable id is no system service's. Fails, naming the file or the process, when
/// the id's file or the process cannot be read.
fn is_system_service_holding(data_folder: &Path) -> anyhow::Result<bool> {
    let path = data_folder.join(DAEMON_PROCESS_ID_FILE_NAME);
    let process_id = match fs::read_to_string(&path) {
        Ok(text) => text.trim().parse::<u32>().ok(),
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => None,
        Err(failure) => {
            return Err(anyhow::Error::new(failure).context(format!(
                "could not read which process holds {}",
                data_folder.display()
            )));
        }
    };
    let Some(process_id) = process_id else {
        return Ok(false);
    };
    let start = read_process_start(process_id).with_context(|| {
        format!("could not read the process {process_id} that holds the data folder")
    })?;
    Ok(start.is_some_and(|start| {
        start
            .arguments
            .iter()
            .any(|argument| argument == SYSTEM_SERVICE_MODE)
    }))
}

/// Removes the command line's login agent list the system service replaced, already unloaded, for
/// a `CommandLine` `owner`. Fails as the removal fails.
fn remove_replaced_agent(
    registration: &impl LoginRegistration,
    owner: ServiceOwner,
) -> anyhow::Result<()> {
    if owner != ServiceOwner::CommandLine {
        return Ok(());
    }
    registration.uninstall().map_err(|failure| {
        registration_failure(
            failure,
            "could not remove the login agent the service replaced",
        )
    })
}

/// Writes `line` on stdout and answers 0.
pub(crate) fn write_line<Output: Write, ErrorOutput: Write>(
    context: &mut CommandContext<Output, ErrorOutput>,
    line: &str,
) -> anyhow::Result<ExitCode> {
    context.stdout.write_all(line.as_bytes())?;
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
    /// installs the system service; a later step's failure puts the earlier ones back first. Sets
    /// `is_lasting_service_stopped` where it stopped a service no login agent ran, which no
    /// put-back starts again.
    async fn run(
        &self,
        ctrl_c: &mut CtrlCListener,
        is_lasting_service_stopped: &mut bool,
    ) -> anyhow::Result<()> {
        // A service that is not running is already stopped.
        let ended = end_running_daemon(
            DaemonEndingVerb::Stop,
            "could not stop the background service before replacing it",
            ctrl_c,
        )
        .await?;
        *is_lasting_service_stopped = !self.was_agent_loaded && ended != DaemonEnd::NotRunning;
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
        let Err(failure) =
            install_system_service(&self.registration, &self.program, self.owner).await
        else {
            return Ok(());
        };
        let put_back = self.put_back().await;
        Err(match failure {
            InstallFailure::Refused(cause) => refused(cause, put_back),
            InstallFailure::Other(failure) => join_put_back(failure, put_back),
        })
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
        let registration = self.registration;
        let owner = self.owner;
        let was_agent_loaded = self.was_agent_loaded;
        run_blocking(move || restore_agent_steps(&registration, owner, was_agent_loaded)).await
    }
}

/// Installs the system service starting `program` through `registration`, behind the
/// administrator password unless the run has root's rights, attributed to the app where the
/// app's agent was the `owner`, from a spawner thread that ends with the step. Fails with the
/// refusal the person is told, or any other failure.
async fn install_system_service(
    registration: &impl LoggedOutServiceRegistration,
    program: &Path,
    owner: ServiceOwner,
) -> Result<(), InstallFailure> {
    let spawner = Spawner::new(Handle::current())
        .context("could not start the thread the administrator step runs from")
        .map_err(InstallFailure::Other)?;
    let installed = registration
        .install_system_service(&spawner, program, owner == ServiceOwner::App)
        .await;
    let Err(failure) = installed else {
        return Ok(());
    };
    Err(
        match read_root_step_failure(failure, registration.runs_as_root()) {
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

/// Starts the login agent again through `registration` where it `was_agent_loaded`: started where
/// it is still loaded, and the command line's own kept list loaded again as it is for a
/// `CommandLine` `owner` where it was unloaded, since the unload leaves the list on disk. The app's
/// agent, once unloaded, is loaded again by the app at its next start or the next login. Fails as
/// the service manager does.
fn restore_agent_steps(
    registration: &impl LoggedOutServiceRegistration,
    owner: ServiceOwner,
    was_agent_loaded: bool,
) -> anyhow::Result<()> {
    if !was_agent_loaded {
        return Ok(());
    }
    let is_loaded = registration.is_agent_loaded().map_err(|failure| {
        registration_failure(failure, "could not read whether the login agent is loaded")
    })?;
    if is_loaded {
        registration.kickstart().map_err(|failure| {
            registration_failure(failure, "could not start the login agent again")
        })?;
    } else if owner == ServiceOwner::CommandLine {
        registration.bootstrap_agent().map_err(|failure| {
            registration_failure(failure, "could not load the login agent again")
        })?;
    }
    Ok(())
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
pub(crate) fn secrets_move_arguments(destination: SecretsMoveDestination) -> Vec<OsString> {
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
    use sidekicks_contracts::daemon::secrets_place::SECRETS_PLACE_RECORD_FILE_NAME;
    use sidekicks_platforms::{
        ServiceInstall, ServiceOwner, ServiceRegistrationError, Spawner, SystemServiceOwner,
    };

    use super::{LoggedOutServiceRefusal, LoggedOutServiceRegistration, install_as_root};
    use crate::command_context::CommandContext;
    use crate::commands::daemon::registration::LoginRegistration;
    use crate::exit_codes::CommandFailure;

    /// A run under `sudo` for an account whose command line agent is loaded and whose home is
    /// `home`, which records the agent's unload and refuses to install anything.
    struct SudoRegistration {
        home: PathBuf,
        is_booted_out: Cell<bool>,
    }

    impl LoginRegistration for SudoRegistration {
        fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
            Ok(ServiceOwner::CommandLine)
        }

        fn install(&self, _program: &Path) -> Result<ServiceInstall, ServiceRegistrationError> {
            unreachable!("nothing was unloaded, so nothing is loaded again")
        }

        fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("a refused run removes no agent")
        }
    }

    impl LoggedOutServiceRegistration for SudoRegistration {
        fn system_service_owner(
            &self,
            _daemon_program: Option<&Path>,
        ) -> Result<SystemServiceOwner, ServiceRegistrationError> {
            Ok(SystemServiceOwner::NotInstalled)
        }

        fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError> {
            Ok(true)
        }

        fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError> {
            self.is_booted_out.set(true);
            Ok(())
        }

        fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("nothing was unloaded, so nothing is started again")
        }

        fn bootstrap_agent(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("nothing was unloaded, so nothing is loaded again")
        }

        fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError> {
            Ok(self.home.clone())
        }

        fn runs_as_root(&self) -> bool {
            true
        }

        #[expect(
            clippy::unused_async_trait_impl,
            reason = "the trait's install waits on its root step; this one refuses at once"
        )]
        async fn install_system_service(
            &self,
            _spawner: &Spawner,
            _daemon_program: &Path,
            _is_attributed_to_app: bool,
        ) -> Result<(), ServiceRegistrationError> {
            unreachable!(
                "a run under sudo installed the service while the keychain held the secrets"
            )
        }
    }

    // Fails when the record's check is dropped or comes after the agent's unload (an unload is
    // recorded), and when it reads only the record's place (the move into the keychain passes on
    // to the install, which panics).
    #[rstest]
    #[case::kept_in_the_keychain(r#"{"place":{"kind":"operatingSystem"}}"#)]
    #[case::moving_into_the_keychain(
        r#"{"place":{"kind":"loggedOutServiceFile"},"movingTo":{"kind":"operatingSystem"}}"#
    )]
    fn a_sudo_run_refuses_while_the_keychain_holds_the_secrets(#[case] record: &str) {
        let home = tempfile::tempdir().expect("a temporary home");
        let data_folder = home.path().join(DAEMON_DATA_FOLDER_NAME);
        std::fs::create_dir(&data_folder).expect("the data folder is made");
        std::fs::write(data_folder.join(SECRETS_PLACE_RECORD_FILE_NAME), record)
            .expect("the record is written");
        let registration = SudoRegistration {
            home: home.path().to_path_buf(),
            is_booted_out: Cell::new(false),
        };
        let mut context = CommandContext {
            stdout: Vec::new(),
            stderr: Vec::new(),
            is_stdout_styled: false,
            is_stderr_styled: false,
        };

        let failure = install_as_root(
            &registration,
            Some(Path::new("/usr/local/bin/sidekicks-daemon")),
            &mut context,
        )
        .expect_err("the run refuses");

        assert!(matches!(
            failure.downcast_ref::<CommandFailure>(),
            Some(CommandFailure::LoggedOutServiceRefused {
                cause: LoggedOutServiceRefusal::KeychainHoldsSecrets,
                put_back_failure: None,
            })
        ));
        assert_eq!(
            failure.to_string(),
            "This Mac cannot keep the background service running while you are logged out: the \
             sign-ins and secrets are in the login keychain. Log in at this Mac once, run the \
             command there, then it runs while you are logged out."
        );
        assert!(
            !registration.is_booted_out.get(),
            "the login agent was unloaded"
        );
        assert!(
            context.stdout.is_empty(),
            "the run printed before it refused"
        );
    }
}
