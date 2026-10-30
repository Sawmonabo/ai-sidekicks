//! `sidekicks daemon install`: registers the background service to start at login and starts it.
//! Where the app's own registration runs the service, nothing is written; a registration already
//! naming this program is left as it is; otherwise the registration is written and, with someone
//! logged in at the screen, loaded, and the command waits for the service's handshake.

use std::convert::Infallible;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::handshake_wait::{
    HandshakeWaitEnd, is_not_ready_yet, wait_for_handshake,
};
use sidekicks_client::daemon_connection::{DaemonEndpoint, HANDSHAKE_DEADLINE};
use sidekicks_client::error::ClientError;
use sidekicks_platforms::{ServiceInstall, ServiceOwner, service_registration};

use crate::command_context::CommandContext;
use crate::commands::daemon::registration::{LoginRegistration, read_owner, registration_failure};
use crate::commands::daemon::start::RepairLine;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, ExitCode};

/// `daemon install`'s options.
#[derive(Debug, Args)]
pub(crate) struct InstallArgs {
    /// The background service's program to register, in place of the one installed beside this
    /// program.
    #[arg(long, value_name = "PATH")]
    daemon_path: Option<PathBuf>,
}

/// Installs the background service to start at login on this computer, and answers 0 with the
/// outcome's line on stdout. Fails with [`CommandFailure::ServiceRegistrationMissing`] on a system
/// with no such registration, and as [`install_with`] does.
pub(crate) fn install<Output: Write, ErrorOutput: Write>(
    args: &InstallArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let registration = service_registration().ok_or(CommandFailure::ServiceRegistrationMissing)?;
    install_with(&registration, args.daemon_path.as_deref(), context)
}

/// Installs through `registration`, its owner read first: the app's registration leaves
/// everything as it is. Fails as the owner's read, the program's resolution, the install or the
/// wait for the started service fails, a step the service manager refused as
/// [`CommandFailure::RegistrationRefused`] and a service that never answers as
/// [`CommandFailure::InstalledNotAnswering`].
fn install_with<Output: Write, ErrorOutput: Write>(
    registration: &impl LoginRegistration,
    daemon_path: Option<&Path>,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let owner = read_owner(registration)?;
    let line = match owner {
        ServiceOwner::App => {
            "The app already runs the background service on this computer. See it with sidekicks \
             daemon status.\n"
        }
        ServiceOwner::CommandLine | ServiceOwner::None => {
            let program = daemon_program(daemon_path)?;
            let installed = registration.install(&program).map_err(|failure| {
                registration_failure(failure, "could not install the background service")
            })?;
            match installed {
                ServiceInstall::Unchanged => {
                    "The background service is already installed. It starts at login.\n"
                }
                ServiceInstall::Loaded => {
                    wait_for_installed_daemon(&mut context.stderr)?;
                    "Installed the background service. It starts at login and is running now.\n"
                }
                ServiceInstall::AtNextLogin => {
                    "Installed the background service. It starts at your next login at this Mac.\n"
                }
            }
        }
    };
    context.stdout.write_all(line.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// Waits for the service the registration's load started to answer the handshake, the repair's
/// line on `stderr` while it repairs its database file. Fails with
/// [`CommandFailure::InstalledNotAnswering`] when it does not answer in time, `ClientError::Canceled`
/// after a Ctrl-C, and as a handshake that fails other than as a starting daemon's does.
fn wait_for_installed_daemon(stderr: &mut impl Write) -> anyhow::Result<()> {
    let mut repair_line = RepairLine::new(stderr);
    let waited = run_listening_for_ctrl_c(async |ctrl_c| {
        let endpoint = DaemonEndpoint::this_machine()
            .context("could not find where the background service listens")?;
        // The service manager owns the started process, so nothing here ends the wait early.
        let waiting = wait_for_handshake(
            endpoint,
            HANDSHAKE_DEADLINE,
            |details| repair_line.show(details),
            std::future::pending::<Infallible>(),
        );
        tokio::select! {
            waited = waiting => match waited {
                Ok(HandshakeWaitEnd::Connected(connection)) => {
                    connection.close().await;
                    Ok(())
                }
                Ok(HandshakeWaitEnd::Ended(never)) => match never {},
                Err(failure) if is_not_ready_yet(&failure) => {
                    Err(CommandFailure::InstalledNotAnswering {
                        waited: HANDSHAKE_DEADLINE,
                        last_failure: failure,
                    }
                    .into())
                }
                Err(failure) => Err(failure.into()),
            },
            _ = ctrl_c.recv() => Err(ClientError::Canceled.into()),
        }
    });
    repair_line.finish()?;
    waited
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::Path;

    use sidekicks_platforms::{ServiceInstall, ServiceOwner, ServiceRegistrationError};

    use super::install_with;
    use crate::command_context::CommandContext;
    use crate::commands::daemon::registration::LoginRegistration;
    use crate::exit_codes::ExitCode;

    /// A registration whose owner is the app's, which records any install it is asked for.
    struct AppOwnedRegistration {
        is_install_asked: Cell<bool>,
    }

    impl LoginRegistration for AppOwnedRegistration {
        fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
            Ok(ServiceOwner::App)
        }

        fn install(&self, _program: &Path) -> Result<ServiceInstall, ServiceRegistrationError> {
            self.is_install_asked.set(true);
            Ok(ServiceInstall::Loaded)
        }

        fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
            unreachable!("an install never removes the registration")
        }
    }

    // Fails when the install skips the owner's read, since the registration is then written over
    // the app's.
    #[test]
    fn an_install_where_the_app_runs_the_service_writes_nothing_and_exits_0() {
        let registration = AppOwnedRegistration {
            is_install_asked: Cell::new(false),
        };
        let mut context = CommandContext {
            stdout: Vec::new(),
            stderr: Vec::new(),
            is_stdout_styled: false,
            is_stderr_styled: false,
        };

        let code = install_with(&registration, None, &mut context).expect("the install succeeds");

        assert_eq!(code, ExitCode::Success);
        assert!(
            !registration.is_install_asked.get(),
            "the install wrote a registration"
        );
        assert_eq!(
            String::from_utf8(context.stdout).expect("UTF-8"),
            "The app already runs the background service on this computer. See it with sidekicks \
             daemon status.\n"
        );
        assert!(context.stderr.is_empty());
    }
}
