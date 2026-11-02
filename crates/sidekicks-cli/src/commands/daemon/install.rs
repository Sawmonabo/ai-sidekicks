//! `sidekicks daemon install`: registers the background service to start at login and starts it.
//! Where this account's system service runs it while the person is logged out, or the app's own
//! registration runs it, nothing is written; a registration already naming this program is left as
//! it is; otherwise the registration is written and, with someone logged in at the screen, loaded,
//! and the command waits for the service's handshake. With
//! `--while-signed-out` the system service that runs while the person is logged out replaces it.

pub(crate) mod system_service;

use std::convert::Infallible;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::handshake_wait::{
    HandshakeWaitEnd, is_not_ready_yet, wait_for_handshake,
};
use sidekicks_client::daemon_connection::{DaemonEndpoint, HANDSHAKE_DEADLINE};
use sidekicks_client::error::ClientError;
use sidekicks_platforms::{ServiceInstall, ServiceOwner, ServiceRegistration, SystemServiceOwner};

use crate::command_context::CommandContext;
use crate::commands::daemon::install::system_service::{
    install_while_signed_out, read_system_service_owner, write_line,
};
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
    /// Keep the background service running while you are logged out (macOS).
    #[arg(long)]
    while_signed_out: bool,
    /// How long to wait for the installed background service to answer, in milliseconds
    /// [default: 10000].
    #[arg(long, value_name = "MS")]
    timeout: Option<u64>,
}

/// Installs the background service on this computer through `registration`, to start at login
/// or with `--while-signed-out` to run while the person is logged out, and answers 0 with the
/// outcome's line on stdout. Fails as the system service's owner's read, [`install_with`] or
/// [`install_while_signed_out`] does.
pub(crate) fn install<Output: Write, ErrorOutput: Write>(
    args: &InstallArgs,
    registration: ServiceRegistration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let deadline = args
        .timeout
        .map_or(HANDSHAKE_DEADLINE, Duration::from_millis);
    if args.while_signed_out {
        return install_while_signed_out(
            registration,
            args.daemon_path.as_deref(),
            deadline,
            context,
        );
    }
    install_with(
        &registration,
        read_system_service_owner(&registration, None)?,
        args.daemon_path.as_deref(),
        deadline,
        context,
    )
}

/// Installs through `registration`, with `system_service_owner` read first: this account's system
/// service and the app's registration leave everything as it is, since a login agent beside either
/// would run a second service, and a started service is waited for within `deadline`. Fails as the
/// owner's read, the program's resolution, the install or the wait for the started service fails,
/// a step the service manager refused as [`CommandFailure::RegistrationRefused`] and a service that
/// never answers as [`CommandFailure::InstalledNotAnswering`].
fn install_with<Output: Write, ErrorOutput: Write>(
    registration: &impl LoginRegistration,
    system_service_owner: SystemServiceOwner,
    daemon_path: Option<&Path>,
    deadline: Duration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match system_service_owner {
        SystemServiceOwner::ThisAccount | SystemServiceOwner::ThisAccountOtherProgram => {
            return write_line(
                context,
                "The background service is already installed to run while you are logged out. \
                 See it with sidekicks daemon status.\n",
            );
        }
        SystemServiceOwner::NotInstalled | SystemServiceOwner::OtherAccount => {}
    }
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
                    wait_for_installed_daemon(&mut context.stderr, deadline)?;
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

/// Waits up to `deadline` for the service the registration's load started to answer the
/// handshake, the repair's line on `stderr` while it repairs its database file. Fails with
/// [`CommandFailure::InstalledNotAnswering`] when it does not answer in time,
/// `ClientError::Canceled` after a Ctrl-C, and as a handshake that fails other than as a starting
/// daemon's does.
pub(crate) fn wait_for_installed_daemon(
    stderr: &mut impl Write,
    deadline: Duration,
) -> anyhow::Result<()> {
    let mut repair_line = RepairLine::new(stderr);
    let waited = run_listening_for_ctrl_c(async |ctrl_c| {
        let endpoint = DaemonEndpoint::this_machine()
            .context("could not find where the background service listens")?;
        // The service manager owns the started process, so nothing here ends the wait early.
        let waiting = wait_for_handshake(
            endpoint,
            deadline,
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
                        waited: deadline,
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

    use sidekicks_client::daemon_connection::HANDSHAKE_DEADLINE;
    use sidekicks_platforms::{
        ServiceInstall, ServiceOwner, ServiceRegistrationError, SystemServiceOwner,
    };

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

        let code = install_with(
            &registration,
            SystemServiceOwner::NotInstalled,
            None,
            HANDSHAKE_DEADLINE,
            &mut context,
        )
        .expect("the install succeeds");

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
        assert_eq!(String::from_utf8(context.stderr).expect("UTF-8"), "");
    }
}
