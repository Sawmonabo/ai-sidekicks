//! The exit codes the command line returns, BSD `sysexits.h` codes plus the code for a negative
//! state a command read and the status a shell reports for a program a closed pipe ended, how a run
//! ends, and the one mapping from a run's failure to its ending.

use std::error::Error;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::backup::BackupManifestError;
use sidekicks_contracts::daemon::data::write_data_folder_held;
use sidekicks_contracts::daemon::service_status::DaemonCannotStart;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
use sidekicks_platforms::{ChildExit, ServiceRegistrationError, read_child_exit};
use strum::VariantArray as _;

use crate::commands::daemon::install::system_service::LoggedOutServiceRefusal;
use crate::commands::daemon::registration::TURNED_OFF_IN_LOGIN_ITEMS;
use crate::commands::daemon::service_status::describe_cannot_start;
use crate::commands::daemon::uninstall::system_service::SystemServiceKeptCause;

/// A process exit code the command line returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::VariantArray)]
pub(crate) enum ExitCode {
    /// The command did what it was asked.
    Success,
    /// The command read a negative state and reported it: the background service serves with a
    /// fault. Not a `sysexits.h` code, since nothing failed.
    Unhealthy,
    /// `EX_USAGE`: the command was invoked or called incorrectly.
    Usage,
    /// `EX_DATAERR`: the input data was malformed.
    DataError,
    /// `EX_NOINPUT`: what the command named does not exist.
    NoInput,
    /// `EX_UNAVAILABLE`: a service the command needs is not answering.
    Unavailable,
    /// `EX_SOFTWARE`: an internal failure.
    Software,
    /// `EX_CANTCREAT`: what the command would create already exists.
    CannotCreate,
    /// `EX_TEMPFAIL`: a temporary failure; the same command may work later.
    TemporaryFailure,
    /// `EX_NOPERM`: the command is not permitted, or its credential is not valid.
    NoPermission,
    /// `EX_CONFIG`: something must change first.
    Configuration,
    /// 128 + SIGPIPE: the reader of the output went away, as git and coreutils exit.
    BrokenPipe,
}

impl ExitCode {
    /// The code's number.
    pub(crate) const fn code(self) -> u8 {
        match self {
            Self::Success => 0,
            Self::Unhealthy => 1,
            Self::Usage => 64,
            Self::DataError => 65,
            Self::NoInput => 66,
            Self::Unavailable => 69,
            Self::Software => 70,
            Self::CannotCreate => 73,
            Self::TemporaryFailure => 75,
            Self::NoPermission => 77,
            Self::Configuration => 78,
            Self::BrokenPipe => 141,
        }
    }

    /// How a run of this program as another account ended, from its `status`: its own exit code,
    /// [`ExitCode::Software`] for a number this program never exits with or another signal's end.
    /// Fails with `ClientError::Canceled` for a run a Ctrl-C ended, so this run ends the same way.
    pub(crate) fn of_program_run(status: ExitStatus) -> anyhow::Result<Self> {
        let exit = read_child_exit(&status, None);
        if exit.signal_name.as_deref() == Some("SIGINT") {
            return Err(ClientError::Canceled.into());
        }
        Ok(Self::VARIANTS
            .iter()
            .copied()
            .find(|code| exit.signal_name.is_none() && i64::from(code.code()) == exit.exit_code)
            .unwrap_or(Self::Software))
    }
}

impl From<ExitCode> for std::process::ExitCode {
    fn from(code: ExitCode) -> Self {
        Self::from(code.code())
    }
}

/// How a run of the command line ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProcessEnding {
    /// The process exits with the code.
    Exit(ExitCode),
    /// The process ends the way a Ctrl-C ends it, so a script running the command stops too: the
    /// command canceled what it waited on after the person pressed Ctrl-C.
    CtrlC,
}

/// The daemon answered with an error number no exit code is assigned to.
#[derive(Debug, thiserror::Error)]
#[error("The background service returned error code {code}, which has no exit code")]
pub(crate) struct UnmappedExitCodeError {
    /// The daemon's number.
    pub(crate) code: i64,
}

/// A failure the command line finds itself, with no daemon number to carry it: each kind names its
/// cause, and its text is the line `error:` prints.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CommandFailure {
    /// The command needs a yes, and neither a terminal to ask at nor `--yes` gives one.
    #[error("no terminal is here to confirm the command: run it again with --yes")]
    ConfirmationUnavailable,
    /// No app on this computer is registered for `sidekicks://` addresses.
    #[error(
        "No app on this computer opens sidekicks:// addresses. Install the AI Sidekicks app, then \
         try again."
    )]
    AddressHandlerMissing,
    /// The background service answered, so a command that needs it stopped was refused before it
    /// asked or changed anything.
    #[error(
        "Stop the background service first: sidekicks daemon stop. Then run sidekicks data \
         {command} again."
    )]
    ServiceRunning {
        /// The `data` command refused, as the person types it.
        command: &'static str,
    },
    /// The folder named as a backup holds no manifest that reads.
    #[error("{} holds no backup whose manifest reads", backup.display())]
    BackupUnreadable {
        /// The folder named.
        backup: PathBuf,
        /// Why its manifest did not read; none when it has no manifest.
        #[source]
        source: Option<BackupManifestError>,
    },
    /// The started daemon did not answer the handshake within the wait, so it was ended.
    #[error(
        "The background service did not answer within {} ms of its start, so it was stopped",
        waited.as_millis()
    )]
    StartTimedOut {
        /// How long the start waited.
        waited: Duration,
        /// The last handshake's failure.
        #[source]
        last_failure: ClientError,
    },
    /// The started daemon exited before it answered the handshake, and no other daemon answers.
    #[error("{}", describe_daemon_exit(exit, cannot_start.as_ref()))]
    DaemonExited {
        /// How the daemon's process ended.
        exit: ChildExit,
        /// Why its start failed, where its status file says.
        cannot_start: Option<DaemonCannotStart>,
    },
    /// The service registered to start at login did not answer the handshake within the wait; the
    /// system's service manager keeps it, so it was not stopped.
    #[error(
        "Installed the background service, but it did not answer within {} ms of its start",
        waited.as_millis()
    )]
    InstalledNotAnswering {
        /// How long the install waited.
        waited: Duration,
        /// The last handshake's failure.
        #[source]
        last_failure: ClientError,
    },
    /// `$HOME` is not the account's home in the user database, so an install or uninstall, which
    /// acts on the account's own login session, changed nothing.
    #[error(
        "HOME is not set to your home folder, so the background service was left as it is. Set \
         HOME to your home folder and run the command again."
    )]
    NotAccountHome,
    /// The app's own registration runs the service, so the command line has nothing of its own to
    /// remove.
    #[error(
        "The app runs the background service on this computer. Turn it off in System Settings \
         › General › Login Items & Extensions."
    )]
    AppOwnsService,
    /// The system's service manager refused a step of the service's registration.
    #[error("The system refused the background service's registration")]
    RegistrationRefused(#[source] ServiceRegistrationError),
    /// The person turned the command line's own login agent off in Login Items, so the start
    /// leaves it off.
    #[error("{}", TURNED_OFF_IN_LOGIN_ITEMS)]
    TurnedOffInLoginItems,
    /// The start was given `--daemon-path`, and the login agent that starts the service runs
    /// another program, so nothing was started.
    #[error(
        "The background service starts at login with its own program, so --daemon-path is not \
         used. Run the command again without --daemon-path."
    )]
    AgentRunsOtherProgram,
    /// The person turned the app's login agent off, so the start leaves it off.
    #[error(
        "The app's background service is turned off. Turn it on in the app's Settings › Runtime."
    )]
    AppServiceTurnedOff,
    /// The login agent's service did not answer the handshake within the wait after its start; the
    /// system's service manager keeps it, so it was not stopped.
    #[error(
        "The background service did not answer within {} ms of its start",
        waited.as_millis()
    )]
    RegisteredNotAnswering {
        /// How long the start waited.
        waited: Duration,
        /// The last handshake's failure.
        #[source]
        last_failure: ClientError,
    },
    /// A service that neither the login agent nor this account's system service runs holds the
    /// data folder, so the command changed nothing.
    #[error("{}", fmt::from_fn(|formatter| write_data_folder_held(formatter, None)))]
    DataFolderHeld,
    /// The service that runs while the person is logged out was not installed, for `cause`; what
    /// the command changed before was put back, and a failure doing that is the source.
    #[error(
        "This Mac cannot keep the background service running while you are logged out: {cause}."
    )]
    LoggedOutServiceRefused {
        /// Why it was not installed.
        cause: LoggedOutServiceRefusal,
        /// Why putting back what the command changed failed, where it did.
        #[source]
        put_back_failure: Option<Box<dyn Error + Send + Sync>>,
    },
    /// The system service that runs while the person is logged out is installed for this account,
    /// and the run has neither root's rights nor a session at the screen, where the administrator
    /// password prompt is drawn, so nothing was changed.
    #[error(
        "The background service runs while you are logged out. Remove it with sudo sidekicks \
         daemon uninstall."
    )]
    SystemServiceNeedsRoot,
    /// Some sign-ins and secrets are in the files of the service that runs while the person is
    /// logged out, and the login keychain cannot take them back now: it is locked, out of this
    /// run's reach, or the run has root's rights.
    #[error(
        "The sign-ins and secrets cannot go back into the login keychain while it is locked. Log \
         in at this Mac, then run sidekicks daemon uninstall again."
    )]
    SecretsKeychainLocked(
        /// The keychain's refusal; none where the run's root rights alone refused it.
        #[source]
        Option<ClientError>,
    ),
    /// The system service that runs while the person is logged out was not removed, for the
    /// cause, whose line this is.
    #[error("{0}")]
    SystemServiceKept(SystemServiceKeptCause),
    /// A run under `sudo` cannot read the account's home folder, as on a network home, so the
    /// command changed nothing.
    #[error(
        "sudo cannot read your home folder, as on a network home. Run the command again without \
         sudo while logged in at this Mac."
    )]
    HomeUnreadable,
    /// This account's system service runs the background service while the person is logged
    /// out, and only root's rights can start it, so nothing was started or stopped.
    #[error(
        "The background service runs while you are logged out. Start it with sudo sidekicks \
         daemon start."
    )]
    SystemServiceStartNeedsRoot,
    /// This account's system service runs the background service while the person is logged
    /// out, and only root's rights can start it again, so the restart asked and stopped nothing.
    #[error(
        "The background service runs while you are logged out. Restart it with sudo sidekicks \
         daemon restart."
    )]
    SystemServiceRestartNeedsRoot,
    /// A start under `sudo` was given `--daemon-path`, and this account's system service runs
    /// another program, so nothing was started or stopped.
    #[error(
        "The background service runs while you are logged out with its own program. Run the \
         command again without --daemon-path."
    )]
    SystemServiceRunsOtherProgram,
    /// A start under `sudo` started this account's system service, and launchd did not run it
    /// within the wait; root cannot reach the service, so nothing was stopped.
    #[error(
        "The background service did not start running within {} ms of its start",
        waited.as_millis()
    )]
    SystemServiceNotRunning {
        /// How long the start waited.
        waited: Duration,
    },
}

impl CommandFailure {
    /// The exit code the failure ends the run with.
    const fn exit_code(&self) -> ExitCode {
        match self {
            Self::StartTimedOut { .. }
            | Self::DaemonExited { .. }
            | Self::InstalledNotAnswering { .. }
            | Self::RegisteredNotAnswering { .. }
            | Self::SystemServiceNotRunning { .. }
            | Self::SecretsKeychainLocked(_)
            | Self::AddressHandlerMissing => ExitCode::Unavailable,
            Self::ConfirmationUnavailable => ExitCode::Usage,
            Self::AppOwnsService
            | Self::TurnedOffInLoginItems
            | Self::AppServiceTurnedOff
            | Self::ServiceRunning { .. }
            | Self::DataFolderHeld
            | Self::NotAccountHome
            | Self::AgentRunsOtherProgram
            | Self::SystemServiceRunsOtherProgram
            | Self::HomeUnreadable => ExitCode::Configuration,
            Self::RegistrationRefused(_) => ExitCode::Software,
            Self::BackupUnreadable { .. } => ExitCode::NoInput,
            Self::LoggedOutServiceRefused { cause, .. } => cause.exit_code(),
            Self::SystemServiceNeedsRoot
            | Self::SystemServiceStartNeedsRoot
            | Self::SystemServiceRestartNeedsRoot => ExitCode::NoPermission,
            Self::SystemServiceKept(cause) => cause.exit_code(),
        }
    }
}

/// The started daemon's exit, then the status file's title and line under it where it has them.
fn describe_daemon_exit(exit: &ChildExit, cannot_start: Option<&DaemonCannotStart>) -> String {
    let line = format!(
        "The background service ended as it started, {}",
        describe_child_ending(exit)
    );
    match cannot_start {
        Some(cannot_start) => format!("{line}\n{}", describe_cannot_start(cannot_start).trim_end()),
        None => line,
    }
}

/// How a child process ended, as a line names it: `on SIGINT`, or `with exit code 1`.
pub(crate) fn describe_child_ending(exit: &ChildExit) -> String {
    match &exit.signal_name {
        Some(signal_name) => format!("on {signal_name}"),
        None => format!("with exit code {}", exit.exit_code),
    }
}

/// How a failed run ends, from the first cause in its chain that names an ending: an argument
/// refusal, a failure the command line found itself by its kind, a daemon that is not answering, a
/// closed output pipe, the daemon's error by its number (a domain refusal by its category), a call
/// canceled after a Ctrl-C; any other failure is a software error. Fails with
/// [`UnmappedExitCodeError`] for a daemon number with no exit code.
pub(crate) fn exit_code_for_failure(
    failure: &anyhow::Error,
) -> Result<ProcessEnding, UnmappedExitCodeError> {
    for cause in failure.chain() {
        if cause.is::<clap::Error>() {
            return Ok(ProcessEnding::Exit(ExitCode::Usage));
        }
        if let Some(command_failure) = cause.downcast_ref::<CommandFailure>() {
            return Ok(ProcessEnding::Exit(command_failure.exit_code()));
        }
        if let Some(client_error) = cause.downcast_ref::<ClientError>() {
            return exit_code_for_client_error(client_error);
        }
        if cause
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
        {
            return Ok(ProcessEnding::Exit(ExitCode::BrokenPipe));
        }
    }
    Ok(ProcessEnding::Exit(ExitCode::Software))
}

fn exit_code_for_client_error(error: &ClientError) -> Result<ProcessEnding, UnmappedExitCodeError> {
    let remote = match error {
        ClientError::Unavailable { .. } => return Ok(ProcessEnding::Exit(ExitCode::Unavailable)),
        ClientError::Remote(remote) => remote,
        // The command cancels a call only after the person pressed Ctrl-C.
        ClientError::Canceled => return Ok(ProcessEnding::CtrlC),
        ClientError::Reply { .. }
        | ClientError::Request { .. }
        | ClientError::RunFolder(_)
        | ClientError::Token { .. } => return Ok(ProcessEnding::Exit(ExitCode::Software)),
    };
    let code = JsonRpcErrorCode::from_code(remote.code)
        .ok_or(UnmappedExitCodeError { code: remote.code })?;
    Ok(match code {
        JsonRpcErrorCode::ParseError => ProcessEnding::Exit(ExitCode::DataError),
        JsonRpcErrorCode::InvalidRequest
        | JsonRpcErrorCode::MethodNotFound
        | JsonRpcErrorCode::InvalidParams => ProcessEnding::Exit(ExitCode::Usage),
        JsonRpcErrorCode::InternalError => ProcessEnding::Exit(ExitCode::Software),
        // The daemon answers a call canceled only after the command's own cancel, which follows
        // the person's Ctrl-C.
        JsonRpcErrorCode::RequestCanceled => ProcessEnding::CtrlC,
        JsonRpcErrorCode::DomainRefusal => remote
            .data
            .as_ref()
            .map_or(ProcessEnding::Exit(ExitCode::Software), |data| {
                exit_code_for_category(&data.category)
            }),
    })
}

fn exit_code_for_category(category: &RefusalCategory) -> ProcessEnding {
    let code = match category {
        RefusalCategory::Known(KnownRefusalCategory::InvalidArgument) => ExitCode::DataError,
        RefusalCategory::Known(KnownRefusalCategory::NotFound) => ExitCode::NoInput,
        RefusalCategory::Known(KnownRefusalCategory::AlreadyExists) => ExitCode::CannotCreate,
        RefusalCategory::Known(KnownRefusalCategory::FailedPrecondition) => ExitCode::Configuration,
        RefusalCategory::Known(
            KnownRefusalCategory::PermissionDenied | KnownRefusalCategory::Unauthenticated,
        ) => ExitCode::NoPermission,
        RefusalCategory::Known(
            KnownRefusalCategory::Aborted
            | KnownRefusalCategory::ResourceExhausted
            | KnownRefusalCategory::DeadlineExceeded,
        ) => ExitCode::TemporaryFailure,
        RefusalCategory::Known(
            KnownRefusalCategory::Unavailable | KnownRefusalCategory::Unimplemented,
        ) => ExitCode::Unavailable,
        // The command calls no method that answers canceled unasked, so a canceled refusal
        // follows its own cancel after the person's Ctrl-C.
        RefusalCategory::Known(KnownRefusalCategory::Canceled) => return ProcessEnding::CtrlC,
        // A category a newer daemon sends is read as an internal failure.
        RefusalCategory::Known(KnownRefusalCategory::Internal) | RefusalCategory::Unknown(_) => {
            ExitCode::Software
        }
    };
    ProcessEnding::Exit(code)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::time::Duration;

    use anyhow::anyhow;
    use clap::CommandFactory as _;
    use rstest::rstest;
    use sidekicks_client::daemon_ending::DaemonEndingError;
    use sidekicks_client::error::{ClientError, LinkFault, RemoteError};
    use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
    use sidekicks_contracts::jsonrpc::message::{ConnectionUnavailableReason, JsonRpcErrorData};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
    use sidekicks_platforms::{ChildExit, ServiceRegistrationError};

    use super::{CommandFailure, ExitCode, ProcessEnding, exit_code_for_failure};
    use crate::commands::daemon::install::system_service::LoggedOutServiceRefusal;
    use crate::commands::daemon::uninstall::system_service::SystemServiceKeptCause;
    use crate::program::Cli;

    fn remote(code: JsonRpcErrorCode, category: Option<RefusalCategory>) -> anyhow::Error {
        let data = category.map(|category| JsonRpcErrorData {
            refusal: RefusalCode::DaemonRepairing.as_str().to_owned(),
            category,
            fields: None,
        });
        ClientError::Remote(RemoteError {
            code: i64::from(code.code()),
            message: "refused".to_owned(),
            data,
        })
        .into()
    }

    fn known(category: KnownRefusalCategory) -> RefusalCategory {
        RefusalCategory::Known(category)
    }

    #[rstest]
    #[case::parse_error(
        remote(JsonRpcErrorCode::ParseError, None),
        ProcessEnding::Exit(ExitCode::DataError)
    )]
    #[case::invalid_request(
        remote(JsonRpcErrorCode::InvalidRequest, None),
        ProcessEnding::Exit(ExitCode::Usage)
    )]
    #[case::method_not_found(
        remote(JsonRpcErrorCode::MethodNotFound, None),
        ProcessEnding::Exit(ExitCode::Usage)
    )]
    #[case::invalid_params(
        remote(JsonRpcErrorCode::InvalidParams, None),
        ProcessEnding::Exit(ExitCode::Usage)
    )]
    #[case::internal_error(
        remote(JsonRpcErrorCode::InternalError, None),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::request_canceled(remote(JsonRpcErrorCode::RequestCanceled, None), ProcessEnding::CtrlC)]
    #[case::refusal_without_data(
        remote(JsonRpcErrorCode::DomainRefusal, None),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::invalid_argument(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::InvalidArgument))
        ),
        ProcessEnding::Exit(ExitCode::DataError)
    )]
    #[case::not_found(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::NotFound))
        ),
        ProcessEnding::Exit(ExitCode::NoInput)
    )]
    #[case::already_exists(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::AlreadyExists))
        ),
        ProcessEnding::Exit(ExitCode::CannotCreate)
    )]
    #[case::failed_precondition(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::FailedPrecondition))
        ),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::permission_denied(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::PermissionDenied))
        ),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::unauthenticated(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Unauthenticated))
        ),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::aborted(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Aborted))
        ),
        ProcessEnding::Exit(ExitCode::TemporaryFailure)
    )]
    #[case::resource_exhausted(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::ResourceExhausted))
        ),
        ProcessEnding::Exit(ExitCode::TemporaryFailure)
    )]
    #[case::deadline_exceeded(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::DeadlineExceeded))
        ),
        ProcessEnding::Exit(ExitCode::TemporaryFailure)
    )]
    #[case::unavailable_repairing(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Unavailable))
        ),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::unimplemented(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Unimplemented))
        ),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::internal(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Internal))
        ),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::canceled(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(known(KnownRefusalCategory::Canceled))
        ),
        ProcessEnding::CtrlC
    )]
    #[case::unknown_category(
        remote(
            JsonRpcErrorCode::DomainRefusal,
            Some(RefusalCategory::Unknown("newerCategory".to_owned()))
        ),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::usage(
        Cli::command().try_get_matches_from(["sidekicks", "unknown"]).expect_err("refused").into(),
        ProcessEnding::Exit(ExitCode::Usage)
    )]
    #[case::no_terminal_to_confirm(
        CommandFailure::ConfirmationUnavailable.into(),
        ProcessEnding::Exit(ExitCode::Usage)
    )]
    #[case::no_app_for_the_address(
        CommandFailure::AddressHandlerMissing.into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::not_answering(
        ClientError::Unavailable {
            reason: ConnectionUnavailableReason::NotListening,
            cause: LinkFault::PeerClosed,
        }.into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::link_down(
        ClientError::link_down(LinkFault::PeerClosed).into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::ending_call_failed(
        anyhow::Error::from(DaemonEndingError::Client(ClientError::link_down(
            LinkFault::PeerClosed
        )))
        .context("could not stop the background service"),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::broken_pipe(
        anyhow::Error::from(io::Error::from(io::ErrorKind::BrokenPipe)).context("writing"),
        ProcessEnding::Exit(ExitCode::BrokenPipe)
    )]
    #[case::canceled_before_it_was_sent(ClientError::Canceled.into(), ProcessEnding::CtrlC)]
    #[case::other_io(
        io::Error::from(io::ErrorKind::PermissionDenied).into(),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::start_timed_out(
        CommandFailure::StartTimedOut {
            waited: Duration::from_millis(200),
            last_failure: ClientError::link_down(LinkFault::PeerClosed),
        }.into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::daemon_exited(
        anyhow::Error::from(CommandFailure::DaemonExited {
            exit: ChildExit { exit_code: 1, signal_number: None, signal_name: None },
            cannot_start: None,
        }).context("could not read why the background service cannot start"),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::installed_not_answering(
        CommandFailure::InstalledNotAnswering {
            waited: Duration::from_millis(200),
            last_failure: ClientError::link_down(LinkFault::PeerClosed),
        }.into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::app_owns_the_service(
        CommandFailure::AppOwnsService.into(),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::registration_refused(
        CommandFailure::RegistrationRefused(ServiceRegistrationError::NoHomeFolder).into(),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::logged_out_service_needs_the_screen(
        CommandFailure::LoggedOutServiceRefused {
            cause: LoggedOutServiceRefusal::NoScreenSession,
            put_back_failure: None,
        }.into(),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::logged_out_service_password_not_given(
        CommandFailure::LoggedOutServiceRefused {
            cause: LoggedOutServiceRefusal::PasswordNotGiven,
            put_back_failure: None,
        }.into(),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::logged_out_service_not_installed_nor_put_back(
        CommandFailure::LoggedOutServiceRefused {
            cause: LoggedOutServiceRefusal::NotInstalled { message: "refused".to_owned() },
            put_back_failure: Some(Box::new(ClientError::link_down(LinkFault::PeerClosed))),
        }.into(),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::system_service_needs_root(
        CommandFailure::SystemServiceNeedsRoot.into(),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::secrets_keychain_locked(
        CommandFailure::SecretsKeychainLocked(None).into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::system_service_kept_password_not_given(
        CommandFailure::SystemServiceKept(SystemServiceKeptCause::PasswordNotGiven).into(),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::system_service_kept_not_removed(
        CommandFailure::SystemServiceKept(SystemServiceKeptCause::NotRemoved {
            message: "refused".to_owned(),
        }).into(),
        ProcessEnding::Exit(ExitCode::Software)
    )]
    #[case::system_service_start_needs_root(
        CommandFailure::SystemServiceStartNeedsRoot.into(),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::system_service_restart_needs_root(
        CommandFailure::SystemServiceRestartNeedsRoot.into(),
        ProcessEnding::Exit(ExitCode::NoPermission)
    )]
    #[case::system_service_runs_other_program(
        CommandFailure::SystemServiceRunsOtherProgram.into(),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::system_service_not_running(
        CommandFailure::SystemServiceNotRunning { waited: Duration::from_millis(200) }.into(),
        ProcessEnding::Exit(ExitCode::Unavailable)
    )]
    #[case::anything_else(anyhow!("failed"), ProcessEnding::Exit(ExitCode::Software))]
    fn a_failure_ends_the_run_as_its_cause_names(
        #[case] failure: anyhow::Error,
        #[case] expected: ProcessEnding,
    ) {
        assert_eq!(
            exit_code_for_failure(&failure).expect("the ending is mapped"),
            expected
        );
    }

    #[test]
    fn a_daemon_number_with_no_exit_code_is_refused() {
        let failure = anyhow::Error::from(ClientError::Remote(RemoteError {
            code: -32_099,
            message: "an unknown code".to_owned(),
            data: None,
        }));
        let refusal = exit_code_for_failure(&failure).expect_err("no exit code is assigned");
        assert_eq!(refusal.code, -32_099);
    }

    // Fails when a run as the account ends this run with a code other than its own, a number this
    // program never exits with reads as one it does, or a run a Ctrl-C ended does not end this one
    // as a Ctrl-C.
    #[cfg(unix)]
    #[test]
    fn a_run_as_the_account_ends_this_run_as_it_ended() {
        use std::os::unix::process::ExitStatusExt as _;
        use std::process::ExitStatus;

        let ended = |raw: i32| ExitCode::of_program_run(ExitStatus::from_raw(raw));

        let codes = [78 << 8, 0, 3 << 8, 15].map(|raw| ended(raw).expect("no Ctrl-C ended it"));
        let interrupted = ended(2).expect_err("a Ctrl-C ended it");

        assert_eq!(
            codes,
            [
                ExitCode::Configuration,
                ExitCode::Success,
                ExitCode::Software,
                ExitCode::Software
            ]
        );
        assert!(matches!(
            interrupted.downcast_ref::<ClientError>(),
            Some(ClientError::Canceled)
        ));
    }
}
