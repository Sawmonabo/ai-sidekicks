//! A lasting service's launch and the connect every start dials: the process started on its log,
//! kept in its record as launched and, once it answers, with where its socket really is.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::value::RawValue;
use sidekicks_platforms::read_socket_link;
use tokio_util::sync::CancellationToken;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::process::{
    CodexProcessLaunch, CodexServiceExit, start_lasting_codex_service,
};
use crate::driver::codex::service::record::{LastingServiceRecord, LockedServiceRecord};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::own_record::{
    EarlierRecordFile, PublishedRecordFile,
};
use crate::driver::codex::service::supervisor::start::kept_records::on_record;
use crate::driver::codex::service::supervisor::start::{
    CodexServiceProcess, StartFailure, start_failed,
};
use crate::driver::codex::service::telemetry_switches::CodexLaunchTelemetry;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, open_codex_connection,
};
use crate::driver::codex::transport::socket::{CodexSocketWait, dial_codex_service_socket};
use crate::driver::codex::version::CODEX_CLIENT_NAME;
use crate::service_log::provider_service_log_file;

/// A lasting service launched and answering on its socket, kept in its record: its process, the
/// daemon's connection and its `initialize` reply, and where its socket really is.
pub(super) struct LaunchedLastingService {
    /// The process, kept in its record.
    pub(super) process: CodexServiceProcess,
    /// The daemon's connection.
    pub(super) connection: Arc<CodexAppServerConnection>,
    /// The service's answer to the connection's `initialize`.
    pub(super) reply: Box<RawValue>,
    /// Where its socket really is.
    pub(super) physical_socket: PathBuf,
    /// The name its launch published its own over.
    pub(super) earlier_record_file: EarlierRecordFile,
}

/// Names the log every lasting service on `service`'s home writes and records it as the service's.
/// Fails when the log cannot be named.
pub(super) fn name_lasting_log_file(service: &CodexService) -> Result<PathBuf, StartFailure> {
    let log_file = provider_service_log_file(
        &service.dependencies().logs_folder,
        &DESCRIPTOR.provider_id(),
        &service.home().codex_home,
    )
    .map_err(|error| start_failed("The Codex service's log could not be named.", error))?;
    service.set_lasting_log_file(log_file.clone());
    Ok(log_file)
}

/// Launches `process_launch`, with its export tag and own telemetry token where it carries them, as
/// a lasting service writing `log_file` and keeping both, keeps its record, with that token and
/// tag, under
/// `locked`, published on `service` first, as launched and, once it answers on `launch_socket`
/// under the ticket `launch`, with where its socket really is; `cancel` stands the wait down.
/// Fails as the launch, the connect, the socket's read or a record's write does, a launched
/// process handed back for the start's teardown with the name published before, which that
/// teardown puts back once it stopped the process.
pub(super) async fn launch_lasting_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    process_launch: (CodexProcessLaunch, Option<CodexLaunchTelemetry>),
    log_file: &Path,
    locked: &Arc<LockedServiceRecord>,
    launch_socket: &Path,
) -> Result<LaunchedLastingService, StartFailure> {
    let (process_launch, telemetry) = process_launch;
    let lasting = start_lasting_codex_service(
        &service.dependencies().spawner,
        process_launch,
        telemetry,
        log_file,
    )
    .await
    .map_err(|error| start_failed("The Codex service could not be started.", error))?;
    let record_file = locked.file().clone();
    // Published before the write, so a daemon stop under way leaves the record to this service.
    let published = PublishedRecordFile::publish(service, record_file.clone());
    let launched = LastingServiceRecord::launched(
        lasting.record().clone(),
        service.socket.home_socket.clone(),
        lasting.kept_telemetry(),
    );
    if let Err(error) = on_record(locked, move |locked| locked.write(&launched)).await {
        return Err(StartFailure {
            error: record_unkept(error),
            process: Some(Box::new(CodexServiceProcess::Lasting {
                service: lasting,
                record_file,
            })),
            earlier_record_file: Some(Box::new(published.hand_back())),
        });
    }
    let opened = connect(
        service,
        launch_socket,
        launch,
        CodexSocketWait::UntilListening,
        lasting.exited(),
        cancel,
    )
    .await;
    let answered = LastingServiceRecord::launched(
        lasting.record().clone(),
        service.socket.home_socket.clone(),
        lasting.kept_telemetry(),
    );
    let process = CodexServiceProcess::Lasting {
        service: lasting,
        record_file,
    };
    let kept = async {
        let (connection, reply) = opened?;
        let physical_socket = read_physical_socket(launch_socket).await?;
        // Kept under the same hold, so a later daemon finds the socket the service really holds.
        let answered = LastingServiceRecord {
            physical_socket: Some(physical_socket.clone()),
            ..answered
        };
        on_record(locked, move |locked| locked.write(&answered))
            .await
            .map_err(record_unkept)?;
        Ok::<_, CodexError>((connection, reply, physical_socket))
    }
    .await;
    match kept {
        Ok((connection, reply, physical_socket)) => Ok(LaunchedLastingService {
            process,
            connection,
            reply,
            physical_socket,
            earlier_record_file: published.hand_back(),
        }),
        Err(error) => Err(StartFailure {
            error,
            process: Some(Box::new(process)),
            earlier_record_file: Some(Box::new(published.hand_back())),
        }),
    }
}

// A record write that failed, which fails the start.
fn record_unkept(error: io::Error) -> CodexError {
    CodexError::Transport {
        detail: "The Codex service's record could not be kept.".to_owned(),
        cause: Some(Box::new(error)),
    }
}

/// Dials the service's socket at `socket` under the ticket `dial` and opens the connection,
/// within the start's deadline and ended early by `exit`, the process's end, or `cancel`; a
/// connection to another process than the last one's begins a new reading of its settings.
/// Answers the connection and its `initialize` reply.
pub(in crate::driver::codex::service::supervisor) async fn connect(
    service: &Arc<CodexService>,
    socket: &Path,
    dial: u64,
    wait: CodexSocketWait,
    exit: Option<CodexServiceExit>,
    cancel: &CancellationToken,
) -> Result<(Arc<CodexAppServerConnection>, Box<RawValue>), CodexError> {
    let dependencies = service.dependencies();
    let startup_timeout = dependencies.startup_timeout;
    let opening = async {
        let (sender, receiver) =
            dial_codex_service_socket(socket, wait, &dependencies.provider_services, cancel)
                .await?;
        service.start_connection(sender.serving_process().cloned());
        open_codex_connection(
            sender,
            receiver,
            service.connection_handlers(dial),
            CODEX_CLIENT_NAME,
            startup_timeout,
        )
        .await
    };
    let ended = async {
        match exit {
            Some(exit) => exit.await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        biased;
        exit = ended.fuse() => Err(CodexError::Transport {
            detail: "The Codex service ended before it answered.".to_owned(),
            cause: Some(match exit {
                Ok(exit) => format!("{exit:?}").into(),
                Err(error) => Box::new(std::io::Error::new(error.kind(), error.to_string())),
            }),
        }),
        opened = tokio::time::timeout(startup_timeout, opening) => match opened {
            Ok(opened) => opened.map(|(connection, reply)| (Arc::new(connection), reply)),
            Err(_elapsed) => Err(CodexError::Transport {
                detail: format!(
                    "The Codex service did not answer within {startup_timeout:?} of its start."
                ),
                cause: None,
            }),
        },
    }
}

/// Where the socket at `socket` really is: the link's target, or `socket` itself where it is no
/// link. Fails with the link's read error, since a socket recorded wrong leaves the home's link on
/// nothing later.
pub(super) async fn read_physical_socket(socket: &Path) -> Result<PathBuf, CodexError> {
    let path = socket.to_owned();
    tokio::task::spawn_blocking(move || read_socket_link(&path))
        .await
        .map_err(io::Error::other)
        .and_then(|read| read)
        .map(|target| target.unwrap_or_else(|| socket.to_owned()))
        .map_err(|error| CodexError::Transport {
            detail: "Where the Codex service's socket really is could not be read.".to_owned(),
            cause: Some(Box::new(error)),
        })
}
