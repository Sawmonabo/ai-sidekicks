//! `sidekicks daemon uninstall` for this account's system service, which keeps the background
//! service running while the person is logged out. Where sign-ins and secrets are in its files, the
//! command first checks that the login keychain takes a value now, and changes nothing when it does
//! not. It then removes the service behind one administrator password, or directly under `sudo`,
//! moves the secrets back into the login keychain in the person's login session, and puts the login
//! agent back. A move back that fails after the removal leaves the agent out, so the next uninstall
//! finds the record still naming the files and finishes the job.
//!
//! Under `sudo` no secrets move, since root cannot reach the login keychain: with items in the
//! files it refuses, and otherwise it puts the agent back by running this program's install as the
//! account, so the agent's list and its folder are the account's own.

use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context as _, bail};
use sidekicks_client::daemon_connection::HANDSHAKE_DEADLINE;
use sidekicks_client::daemon_ending::DaemonEndingVerb;
use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::secrets_place::{
    PlaceRecord, SECRETS_KEYCHAIN_CHECK_MODE, SecretsMoveDestination,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_platforms::{
    CtrlCListener, ServiceInstall, ServiceOwner, ServiceRegistration, ServiceRegistrationError,
    Spawner, read_child_exit,
};
use tokio::runtime::Handle;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::install::system_service::{
    LoggedOutServiceRegistration, secrets_move_arguments, write_line,
};
use crate::commands::daemon::install::wait_for_installed_daemon;
use crate::commands::daemon::registration::{
    RootStepFailure, read_root_step_failure, registration_failure,
};
use crate::commands::daemon::secrets_place::read_secrets_place;
use crate::commands::data::offline_mode::run_offline_mode;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::this_program;
use crate::exit_codes::{CommandFailure, ExitCode, describe_child_ending};

/// The line for the system service removed and the login agent's service running.
const REMOVED_RUNNING_LINE: &str = "The background service no longer runs while you are logged \
                                    out. It starts at login and is running now.\n";

/// The line for the system service removed and the login agent left to start at the next login.
const REMOVED_AT_NEXT_LOGIN_LINE: &str = "The background service no longer runs while you are \
                                          logged out. It starts at your next login at this Mac.\n";

/// Why the system service was not removed, each with the line the person is told.
#[derive(Debug)]
pub(crate) enum SystemServiceKeptCause {
    /// The person canceled the administrator password prompt, which comes before any change.
    PasswordNotGiven,
    /// macOS did not remove it, with its own message; the service may already be stopped, since
    /// it is unloaded before its list is deleted.
    NotRemoved {
        /// macOS's message, or what could not be started.
        message: String,
    },
}

impl SystemServiceKeptCause {
    /// The exit code the cause ends the run with: 77 for the password not given, 70 for a
    /// removal macOS failed.
    pub(crate) const fn exit_code(&self) -> ExitCode {
        match self {
            Self::PasswordNotGiven => ExitCode::NoPermission,
            Self::NotRemoved { .. } => ExitCode::Software,
        }
    }
}

impl fmt::Display for SystemServiceKeptCause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PasswordNotGiven => formatter.write_str(
                "The background service still runs while you are logged out: the administrator \
                 password was not given.",
            ),
            Self::NotRemoved { message } => write!(
                formatter,
                "The background service could not be fully removed: {message}. Check it with \
                 sidekicks daemon status."
            ),
        }
    }
}

/// The steps the system service's uninstall takes beside the install's, behind one trait so a
/// test can answer for the service manager and the daemon's program.
pub(crate) trait LoggedOutServiceUninstall: LoggedOutServiceRegistration {
    /// Whether this account is logged in at the Mac's screen; fails when it cannot be read.
    fn has_screen_session(&self) -> Result<bool, ServiceRegistrationError>;

    /// Removes the system service, its root step started on `spawner`'s thread; fails with the
    /// step's cause.
    async fn uninstall_system_service(
        &self,
        spawner: &Spawner,
    ) -> Result<(), ServiceRegistrationError>;

    /// The command that runs `program` as this account; fails when the account cannot be named.
    fn account_command(&self, program: &Path) -> Result<Command, ServiceRegistrationError>;

    /// Runs the daemon's program `program` in the mode `arguments` name. Fails with the mode's
    /// refusal as a `ClientError::Remote`, and as the program's run fails.
    async fn run_daemon_mode(&self, program: &Path, arguments: Vec<OsString>)
    -> anyhow::Result<()>;

    /// Stops the running background service, which holds the data folder, so the move back can
    /// take it; a service not running is already stopped. Fails with `ClientError::Canceled` after
    /// a Ctrl-C on `ctrl_c`, and as the stop fails.
    async fn end_running_service(&self, ctrl_c: &mut CtrlCListener) -> anyhow::Result<()>;
}

impl LoggedOutServiceUninstall for ServiceRegistration {
    fn has_screen_session(&self) -> Result<bool, ServiceRegistrationError> {
        ServiceRegistration::has_screen_session(self)
    }

    async fn uninstall_system_service(
        &self,
        spawner: &Spawner,
    ) -> Result<(), ServiceRegistrationError> {
        ServiceRegistration::uninstall_system_service(self, spawner).await
    }

    fn account_command(&self, program: &Path) -> Result<Command, ServiceRegistrationError> {
        ServiceRegistration::account_command(self, program)
    }

    async fn run_daemon_mode(
        &self,
        program: &Path,
        arguments: Vec<OsString>,
    ) -> anyhow::Result<()> {
        run_offline_mode(program, arguments).await
    }

    async fn end_running_service(&self, ctrl_c: &mut CtrlCListener) -> anyhow::Result<()> {
        end_running_daemon(
            DaemonEndingVerb::Stop,
            "could not stop the background service before moving the secrets back",
            ctrl_c,
        )
        .await?;
        Ok(())
    }
}

/// Removes this account's system service through `registration`, the login agent's `owner` read
/// first, the daemon's program `program` running the secrets' modes, and answers 0 with the
/// outcome's line on stdout. Fails with [`CommandFailure::SystemServiceNeedsRoot`] with neither
/// root's rights nor a session at the screen; with [`CommandFailure::SecretsKeychainLocked`] when
/// items are in the files and the run has root's rights, the login keychain refuses the check, or
/// it refuses the move back after the removal; with [`CommandFailure::SystemServiceKept`] when the
/// prompt is canceled or macOS does not remove it; `ClientError::Canceled` after a Ctrl-C while a
/// login agent's service stops for the move; and as a read, the removal, that stop, the agent's
/// install or start, or the wait for its service fails.
pub(crate) fn uninstall_logged_out_service<Output: Write, ErrorOutput: Write>(
    registration: &impl LoggedOutServiceUninstall,
    owner: ServiceOwner,
    program: &Path,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let runs_as_root = registration.runs_as_root();
    if !runs_as_root {
        let has_screen_session = registration.has_screen_session().map_err(|failure| {
            registration_failure(failure, "could not read whether anyone is at the screen")
        })?;
        if !has_screen_session {
            return Err(CommandFailure::SystemServiceNeedsRoot.into());
        }
    }
    let has_secrets_in_files = are_secrets_in_files(registration)?;
    if has_secrets_in_files && runs_as_root {
        return Err(CommandFailure::SecretsKeychainLocked(None).into());
    }
    // A Ctrl-C reaches the modes and the prompt, which share the terminal, and the command still
    // reads how each ended; only the service's stop watches the listener.
    run_listening_for_ctrl_c(async |ctrl_c| {
        if has_secrets_in_files {
            check_keychain(registration, program).await?;
        }
        remove_system_service(registration).await?;
        if has_secrets_in_files {
            // A login agent's service, such as the app's while the system service was turned off,
            // may hold the data folder the move takes; the agent is started again below.
            registration.end_running_service(ctrl_c).await?;
            move_secrets_back(registration, program).await?;
        }
        Ok(())
    })?;
    let line = put_agent_back(registration, owner, program, &mut context.stderr).context(
        "removed the background service that runs while you are logged out, but could not put \
         the login agent back",
    )?;
    write_line(context, line)
}

/// Moves the secrets back into the login keychain for an uninstall of the system service that
/// stopped after the removal, through `registration` and the daemon's program `program`: the
/// keychain checked first, then the service ended where `is_agent_loaded`, since the move holds the
/// data folder, then the move. Fails with [`CommandFailure::SecretsKeychainLocked`] under root's
/// rights and when the keychain refuses the check or the move, `ClientError::Canceled` after a
/// Ctrl-C while the service stops, and as the mode's run or the service's stop fails.
pub(crate) fn finish_moving_secrets_back(
    registration: &impl LoggedOutServiceUninstall,
    program: &Path,
    is_agent_loaded: bool,
) -> anyhow::Result<()> {
    if registration.runs_as_root() {
        return Err(CommandFailure::SecretsKeychainLocked(None).into());
    }
    run_listening_for_ctrl_c(async |ctrl_c| {
        check_keychain(registration, program).await?;
        if is_agent_loaded {
            registration.end_running_service(ctrl_c).await?;
        }
        move_secrets_back(registration, program).await
    })
}

/// Whether the record in the account's data folder names the system service's files, so some
/// sign-ins and secrets may be there. Fails as the home's or the record's read fails.
pub(crate) fn are_secrets_in_files(
    registration: &impl LoggedOutServiceRegistration,
) -> anyhow::Result<bool> {
    let home = registration
        .account_home()
        .map_err(|failure| registration_failure(failure, "could not read this account's home"))?;
    Ok(read_secrets_place(&home)?.is_some_and(PlaceRecord::names_logged_out_service_file))
}

/// Puts the login agent back through `registration` and starts it: the command line's agent for
/// `program` unless the app's agent is the `owner`, installed under root's rights by running this
/// program's install as the account, and a loaded agent started, since its service could not run
/// beside the system service. Answers the line for what it did, the next login's where the agent
/// is not loaded. Fails as the install, the start or the wait for the service on `stderr` fails.
pub(crate) fn put_agent_back(
    registration: &impl LoggedOutServiceUninstall,
    owner: ServiceOwner,
    program: &Path,
    stderr: &mut impl Write,
) -> anyhow::Result<&'static str> {
    if owner != ServiceOwner::App {
        if registration.runs_as_root() {
            install_agent_as_account(registration)?;
        } else {
            let installed = registration.install(program).map_err(|failure| {
                registration_failure(failure, "could not install the login agent")
            })?;
            match installed {
                ServiceInstall::Loaded => {
                    wait_for_installed_daemon(stderr, HANDSHAKE_DEADLINE)?;
                    return Ok(REMOVED_RUNNING_LINE);
                }
                ServiceInstall::AtNextLogin => return Ok(REMOVED_AT_NEXT_LOGIN_LINE),
                ServiceInstall::Unchanged => {}
            }
        }
    }
    let is_loaded = registration.is_agent_loaded().map_err(|failure| {
        registration_failure(failure, "could not read whether the login agent is loaded")
    })?;
    if !is_loaded {
        return Ok(REMOVED_AT_NEXT_LOGIN_LINE);
    }
    registration
        .kickstart()
        .map_err(|failure| registration_failure(failure, "could not start the login agent"))?;
    // Root cannot pass the service's own-account check, so only the account's own run waits.
    if !registration.runs_as_root() {
        wait_for_installed_daemon(stderr, HANDSHAKE_DEADLINE)?;
    }
    Ok(REMOVED_RUNNING_LINE)
}

/// Installs the command line's login agent by running this program's `daemon install` as the
/// account through `registration`, its own line dropped for the uninstall's and its failure lines
/// on this command's error output. Fails when this program or the account cannot be named, the
/// run cannot start, or the install fails.
fn install_agent_as_account(registration: &impl LoggedOutServiceUninstall) -> anyhow::Result<()> {
    let program = this_program()?;
    let mut command = registration.account_command(&program).map_err(|failure| {
        registration_failure(
            failure,
            "could not name the account to put the login agent back for",
        )
    })?;
    let status = command
        .args(["daemon", "install"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .with_context(|| format!("could not run {} as this account", program.display()))?;
    if !status.success() {
        bail!(
            "the login agent's install, run as this account, ended {}",
            describe_child_ending(&read_child_exit(&status, None))
        );
    }
    Ok(())
}

/// Removes the system service through `registration`, behind the administrator password unless
/// the run has root's rights. Fails with [`CommandFailure::SystemServiceKept`] when the prompt is
/// canceled or macOS does not remove it, and as the spawner's start or another failure.
async fn remove_system_service(
    registration: &impl LoggedOutServiceUninstall,
) -> anyhow::Result<()> {
    let spawner = Spawner::new(Handle::current())
        .context("could not start the thread the administrator step runs from")?;
    let Err(failure) = registration.uninstall_system_service(&spawner).await else {
        return Ok(());
    };
    Err(
        match read_root_step_failure(failure, registration.runs_as_root()) {
            RootStepFailure::Canceled => {
                CommandFailure::SystemServiceKept(SystemServiceKeptCause::PasswordNotGiven).into()
            }
            RootStepFailure::NotDone { message } => {
                CommandFailure::SystemServiceKept(SystemServiceKeptCause::NotRemoved { message })
                    .into()
            }
            RootStepFailure::Other(failure) => registration_failure(
                failure,
                "could not remove the background service that runs while you are logged out",
            ),
        },
    )
}

/// Checks through the daemon's program `program` that the login keychain takes a value now.
/// Fails with [`CommandFailure::SecretsKeychainLocked`] when it refuses, and as the mode's run
/// fails.
async fn check_keychain(
    registration: &impl LoggedOutServiceUninstall,
    program: &Path,
) -> anyhow::Result<()> {
    let arguments = SECRETS_KEYCHAIN_CHECK_MODE
        .into_iter()
        .map(OsString::from)
        .collect();
    registration
        .run_daemon_mode(program, arguments)
        .await
        .map_err(read_keychain_refusal)
}

/// Moves the secrets from the system service's files back into the login keychain through the
/// daemon's program `program`. Fails with [`CommandFailure::SecretsKeychainLocked`] when the
/// keychain refuses, and as the mode's run or its other refusals fail.
async fn move_secrets_back(
    registration: &impl LoggedOutServiceUninstall,
    program: &Path,
) -> anyhow::Result<()> {
    registration
        .run_daemon_mode(
            program,
            secrets_move_arguments(SecretsMoveDestination::OperatingSystem),
        )
        .await
        .map_err(read_keychain_refusal)
}

/// `failure` of a secrets mode, a refusal of the login keychain read as
/// [`CommandFailure::SecretsKeychainLocked`], whose line says what to do in its place and whose
/// source is the refusal.
fn read_keychain_refusal(failure: anyhow::Error) -> anyhow::Error {
    let is_keychain_refusal = matches!(
        failure.downcast_ref::<ClientError>(),
        Some(ClientError::Remote(remote)) if remote.data.as_ref().is_some_and(|data| {
            data.refusal == RefusalCode::DaemonDataStoreUnavailable.as_str()
        })
    );
    if !is_keychain_refusal {
        return failure;
    }
    let refusal = failure
        .downcast::<ClientError>()
        .expect("the failure was read as the client's error");
    CommandFailure::SecretsKeychainLocked(Some(refusal)).into()
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use sidekicks_client::error::{ClientError, RemoteError};
    use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
    use sidekicks_contracts::daemon::secrets_place::{
        SECRETS_KEYCHAIN_CHECK_MODE, SECRETS_PLACE_RECORD_FILE_NAME,
    };
    use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
    use sidekicks_contracts::jsonrpc::message::JsonRpcErrorData;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
    use sidekicks_platforms::{
        CtrlCListener, ServiceInstall, ServiceOwner, ServiceRegistrationError, Spawner,
        SystemServiceOwner,
    };

    use super::{LoggedOutServiceUninstall, uninstall_logged_out_service};
    use crate::command_context::CommandContext;
    use crate::commands::daemon::install::system_service::LoggedOutServiceRegistration;
    use crate::commands::daemon::registration::LoginRegistration;
    use crate::exit_codes::CommandFailure;

    /// A run at the screen for an account whose home is `home`, whose login keychain refuses every
    /// mode, which records each mode run, any removal of the system service and any stop of the
    /// running service.
    struct LockedKeychainRegistration {
        home: PathBuf,
        modes_run: RefCell<Vec<Vec<OsString>>>,
        is_removal_asked: Cell<bool>,
        is_stop_asked: Cell<bool>,
    }

    impl LoginRegistration for LockedKeychainRegistration {
        fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
            unreachable!("the uninstall is handed the owner")
        }

        fn install(&self, _program: &Path) -> Result<ServiceInstall, ServiceRegistrationError> {
            unreachable!("a refused uninstall puts no agent back")
        }

        fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("a refused uninstall removes no agent")
        }
    }

    impl LoggedOutServiceRegistration for LockedKeychainRegistration {
        fn system_service_owner(
            &self,
            _daemon_program: Option<&Path>,
        ) -> Result<SystemServiceOwner, ServiceRegistrationError> {
            unreachable!("the uninstall is reached once the owner is read")
        }

        fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError> {
            unreachable!("a refused uninstall starts no agent")
        }

        fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("the uninstall unloads no agent")
        }

        fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("a refused uninstall starts no agent")
        }

        fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError> {
            Ok(self.home.clone())
        }

        fn runs_as_root(&self) -> bool {
            false
        }

        #[expect(
            clippy::unused_async_trait_impl,
            reason = "the trait's install waits on its root step; the uninstall never calls it"
        )]
        async fn install_system_service(
            &self,
            _spawner: &Spawner,
            _daemon_program: &Path,
            _is_app_installed: bool,
        ) -> Result<(), ServiceRegistrationError> {
            unreachable!("the uninstall installs no system service")
        }
    }

    impl LoggedOutServiceUninstall for LockedKeychainRegistration {
        fn has_screen_session(&self) -> Result<bool, ServiceRegistrationError> {
            Ok(true)
        }

        #[expect(
            clippy::unused_async_trait_impl,
            reason = "the trait's removal waits on its root step; this one records the ask"
        )]
        async fn uninstall_system_service(
            &self,
            _spawner: &Spawner,
        ) -> Result<(), ServiceRegistrationError> {
            self.is_removal_asked.set(true);
            Ok(())
        }

        fn account_command(&self, _program: &Path) -> Result<Command, ServiceRegistrationError> {
            unreachable!("a run at the screen installs the agent itself")
        }

        #[expect(
            clippy::unused_async_trait_impl,
            reason = "the trait's mode waits on the daemon's program; this keychain refuses at once"
        )]
        async fn run_daemon_mode(
            &self,
            _program: &Path,
            arguments: Vec<OsString>,
        ) -> anyhow::Result<()> {
            self.modes_run.borrow_mut().push(arguments);
            Err(ClientError::Remote(RemoteError {
                code: i64::from(JsonRpcErrorCode::DomainRefusal.code()),
                message: "the login keychain is locked".to_owned(),
                data: Some(JsonRpcErrorData {
                    refusal: RefusalCode::DaemonDataStoreUnavailable.as_str().to_owned(),
                    category: RefusalCategory::Known(KnownRefusalCategory::Unavailable),
                    fields: None,
                }),
            })
            .into())
        }

        #[expect(
            clippy::unused_async_trait_impl,
            reason = "the trait's stop waits on the service; this one records the ask"
        )]
        async fn end_running_service(&self, _ctrl_c: &mut CtrlCListener) -> anyhow::Result<()> {
            self.is_stop_asked.set(true);
            Ok(())
        }
    }

    // Fails when the check is dropped or comes after the removal or the stop (the removal or the
    // stop is recorded, and a dropped check runs the move in its place), and when the keychain's
    // refusal is not read as the locked line.
    #[test]
    fn a_locked_keychain_keeps_the_system_service() {
        let home = tempfile::tempdir().expect("a temporary home");
        let data_folder = home.path().join(DAEMON_DATA_FOLDER_NAME);
        std::fs::create_dir(&data_folder).expect("the data folder is made");
        std::fs::write(
            data_folder.join(SECRETS_PLACE_RECORD_FILE_NAME),
            r#"{"place":{"kind":"loggedOutServiceFile"}}"#,
        )
        .expect("the record is written");
        let registration = LockedKeychainRegistration {
            home: home.path().to_path_buf(),
            modes_run: RefCell::new(Vec::new()),
            is_removal_asked: Cell::new(false),
            is_stop_asked: Cell::new(false),
        };
        let mut context = CommandContext {
            stdout: Vec::new(),
            stderr: Vec::new(),
            is_stdout_styled: false,
            is_stderr_styled: false,
        };

        let failure = uninstall_logged_out_service(
            &registration,
            ServiceOwner::CommandLine,
            Path::new("/usr/local/bin/sidekicks-daemon"),
            &mut context,
        )
        .expect_err("the uninstall refuses");

        assert!(matches!(
            failure.downcast_ref::<CommandFailure>(),
            Some(CommandFailure::SecretsKeychainLocked(Some(
                ClientError::Remote(_)
            )))
        ));
        assert_eq!(
            failure.to_string(),
            "The sign-ins and secrets cannot go back into the login keychain while it is locked. \
             Log in at this Mac, then run sidekicks daemon uninstall again."
        );
        assert!(
            !registration.is_removal_asked.get(),
            "the system service was removed"
        );
        assert!(
            !registration.is_stop_asked.get(),
            "the running service was stopped"
        );
        let check: Vec<OsString> = SECRETS_KEYCHAIN_CHECK_MODE
            .into_iter()
            .map(OsString::from)
            .collect();
        assert_eq!(*registration.modes_run.borrow(), vec![check]);
        assert!(context.stdout.is_empty(), "the uninstall printed a line");
    }
}
