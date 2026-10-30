//! The exit codes the command line returns, BSD `sysexits.h` codes plus the code for a negative
//! state a command read and the status a shell reports for a program a closed pipe ended, how a run
//! ends, and the one mapping from a run's failure to its ending.

use std::io;
use std::time::Duration;

use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::service_status::DaemonCannotStart;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
use sidekicks_platforms::{ChildExit, ServiceRegistrationError};

use crate::commands::daemon::status::describe_cannot_start;
use crate::confirmation::ConfirmationUnavailableError;

/// A process exit code the command line returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    /// This system has no registration that starts the service at login.
    #[error("The background service cannot be registered to start at login on this system")]
    ServiceRegistrationMissing,
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
}

impl CommandFailure {
    /// The exit code the failure ends the run with.
    const fn exit_code(&self) -> ExitCode {
        match self {
            Self::StartTimedOut { .. }
            | Self::DaemonExited { .. }
            | Self::InstalledNotAnswering { .. } => ExitCode::Unavailable,
            Self::ServiceRegistrationMissing | Self::AppOwnsService => ExitCode::Configuration,
            Self::RegistrationRefused(_) => ExitCode::Software,
        }
    }
}

/// The started daemon's exit, then the status file's title and line under it where it has them.
fn describe_daemon_exit(exit: &ChildExit, cannot_start: Option<&DaemonCannotStart>) -> String {
    let ended = match &exit.signal_name {
        Some(signal_name) => format!("on {signal_name}"),
        None => format!("with exit code {}", exit.exit_code),
    };
    let line = format!("The background service ended as it started, {ended}");
    match cannot_start {
        Some(cannot_start) => format!("{line}\n{}", describe_cannot_start(cannot_start).trim_end()),
        None => line,
    }
}

/// How a failed run ends, from the first cause in its chain that names an ending: an argument
/// refusal or a confirmation no one can answer, a failure the command line found itself by its
/// kind, a daemon that is not answering, a closed output pipe, the daemon's error by its number (a
/// domain refusal by its category), a call canceled after a Ctrl-C; any other failure is a
/// software error. Fails with [`UnmappedExitCodeError`] for a daemon number with no exit code.
pub(crate) fn exit_code_for_failure(
    failure: &anyhow::Error,
) -> Result<ProcessEnding, UnmappedExitCodeError> {
    for cause in failure.chain() {
        if cause.is::<clap::Error>() || cause.is::<ConfirmationUnavailableError>() {
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
    use sidekicks_client::error::{ClientError, LinkFault, RemoteError};
    use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
    use sidekicks_contracts::jsonrpc::message::{ConnectionUnavailableReason, JsonRpcErrorData};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
    use sidekicks_platforms::{ChildExit, ServiceRegistrationError};

    use super::{CommandFailure, ExitCode, ProcessEnding, exit_code_for_failure};
    use crate::confirmation::ConfirmationUnavailableError;
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
        ConfirmationUnavailableError.into(),
        ProcessEnding::Exit(ExitCode::Usage)
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
    #[case::no_service_registration_here(
        CommandFailure::ServiceRegistrationMissing.into(),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::app_owns_the_service(
        CommandFailure::AppOwnsService.into(),
        ProcessEnding::Exit(ExitCode::Configuration)
    )]
    #[case::registration_refused(
        CommandFailure::RegistrationRefused(ServiceRegistrationError::NoHomeFolder).into(),
        ProcessEnding::Exit(ExitCode::Software)
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
}
