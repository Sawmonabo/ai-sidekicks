//! How each kind of Codex service starts, and what every start shares: the connect, the read of
//! the loaded conversations and of the reported version, and the launch on Codex's native program.
//! A service on an account home is the daemon's own child, dialed once it listens, with the
//! daemon's relay to its executor added before it answers; the capability read's, and a read's
//! transient one on the person's own Codex folder, run without one; the terminal service on that
//! folder starts as `terminal` says.

pub(super) mod kept_records;
mod terminal;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_platforms::{create_private_folder, read_socket_link};
use tokio_util::sync::CancellationToken;

use crate::driver::ReportedVersionReading;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::ThreadLoadedListParams;
use crate::driver::codex::exec_relay::{CODEX_EXECUTOR_ARGUMENTS, CodexExecRelay, RelayedThread};
use crate::driver::codex::native_program::resolve_codex_native_program;
use crate::driver::codex::service::command_line::{
    CodexServiceCommandLineInput, compose_codex_service_arguments,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceKind};
use crate::driver::codex::service::process::{
    CodexProcessLaunch, CodexServiceExit, LastingCodexService, ManagedCodexService,
    start_managed_codex_service,
};
use crate::driver::codex::service::record::LastingServiceRecordFile;
use crate::driver::codex::service::start_lock::{CodexStartLock, take_codex_start_lock};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::terminal::start_terminal_service;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, open_codex_connection, read_codex_object,
};
use crate::driver::codex::transport::socket::{CodexSocketWait, dial_codex_service_socket};
use crate::driver::codex::version::{
    CODEX_CLIENT_NAME, CodexInitializeReply, read_reported_version,
};
use crate::driver::contract::params_and_results::DriverCliVersionReport;
use crate::output_validation::check_cli_version_report;
use crate::spawned_version::{
    ResolvedProviderExecutable, SpawnedProviderVersionReading, parse_cli_version_report,
};

/// The folder under the daemon's data folder every Codex service the daemon starts runs in, empty,
/// since Codex takes its process folder as the project when a request names none.
const CODEX_SERVICE_WORKING_FOLDER: &str = "codex-service";

/// The most conversations one `thread/loaded/list` page answers.
const LOADED_THREADS_PAGE_LIMIT: u32 = 100;

/// The most pages one loaded-conversations read follows.
const LOADED_THREADS_PAGE_BOUND: usize = 20;

const THREAD_LOADED_LIST_METHOD: &str = "thread/loaded/list";

const ENVIRONMENT_ADD_METHOD: &str = "environment/add";

/// A service process the daemon started or re-pinned.
pub(crate) enum CodexServiceProcess {
    /// The daemon's own child on an account home.
    Managed(ManagedCodexService),
    /// The lasting service on the person's own Codex folder, with the file its record is kept in.
    Lasting {
        /// The service.
        service: LastingCodexService,
        /// Its record's file.
        record_file: LastingServiceRecordFile,
    },
}

impl CodexServiceProcess {
    /// The process's exit, `None` for a lasting service a former daemon started, whose end reads
    /// from its connection's end.
    pub(super) fn exited(&self) -> Option<CodexServiceExit> {
        match self {
            Self::Managed(managed) => Some(managed.exited()),
            Self::Lasting { service, .. } => service.exited(),
        }
    }

    /// The process's id, when the system gave one.
    pub(super) fn process_id(&self) -> Option<u32> {
        match self {
            Self::Managed(managed) => managed.process_id(),
            Self::Lasting { service, .. } => Some(service.record().id()),
        }
    }
}

/// A service a start brought up: what it found the service to be, the process it holds, its
/// connection and the version it reported.
pub(super) struct StartedService {
    /// What the service is.
    pub(super) kind: CodexServiceKind,
    /// The process, `None` for a service the daemon only joined.
    pub(super) process: Option<CodexServiceProcess>,
    /// The daemon's connection.
    pub(super) connection: Arc<CodexAppServerConnection>,
    /// The version the service reported, with the build resolved at the start.
    pub(super) version: SpawnedProviderVersionReading,
    /// Where its socket really is: the target of the link at the path it was dialed on, or that
    /// path where it is no link.
    pub(super) physical_socket: PathBuf,
    /// Whether a terminal service a former daemon left runs other hooks than this daemon's, so a
    /// planned restart is owed once it is up.
    pub(super) is_restart_owed: bool,
}

/// A start that failed, with the process it launched, which the runner tears down.
pub(super) struct StartFailure {
    /// Why.
    pub(super) error: CodexError,
    /// What it launched, if anything, boxed so the failure stays small.
    pub(super) process: Option<Box<CodexServiceProcess>>,
}

impl From<CodexError> for StartFailure {
    fn from(error: CodexError) -> Self {
        Self {
            error,
            process: None,
        }
    }
}

// The members of a `thread/loaded/list` page the read reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadedThreadsPage {
    data: Vec<Box<RawValue>>,
    next_cursor: Option<String>,
}

/// Starts or joins `service` under the start ticket `launch`; `cancel` stands the start down.
/// `start_lock` is Codex's start lock, held from the stop of the managed daemon this start takes
/// the place of, so no terminal starts another in between.
pub(super) async fn start_codex_service(
    service: Arc<CodexService>,
    launch: u64,
    cancel: CancellationToken,
    start_lock: Option<CodexStartLock>,
) -> Result<StartedService, StartFailure> {
    let executable = service
        .dependencies()
        .program
        .resolve(service.home())
        .await
        .map_err(|error| CodexError::Transport {
            detail: "The Codex command could not be resolved.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    match service.home().kind {
        CodexHomeKind::Account(_) => {
            start_relayed_service(&service, launch, &cancel, &executable).await
        }
        CodexHomeKind::CapabilityRead => {
            start_account_service(&service, launch, &cancel, &executable).await
        }
        // A read's transient service on the folder is the daemon's own child, as an account's is.
        CodexHomeKind::PersonalFolder if service.kind() == CodexServiceKind::Account => {
            start_account_service(&service, launch, &cancel, &executable).await
        }
        CodexHomeKind::PersonalFolder => {
            start_terminal_service(&service, launch, &cancel, &executable, start_lock).await
        }
    }
}

// An account's service: its relay readied first, the service then started as every child of the
// daemon is, and the relay's environment added on its connection before the start answers, so it
// precedes any resume of a conversation there.
async fn start_relayed_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let relay = service.exec_relay_or_insert_with(|| compose_exec_relay(service));
    let executor_launch = compose_codex_native_launch(
        &service.dependencies().data_folder,
        executable,
        CODEX_EXECUTOR_ARGUMENTS
            .iter()
            .map(|argument| (*argument).to_owned())
            .collect(),
    )
    .await?;
    let environment_add = relay.start(executor_launch.into_command()).await?;
    let started = start_account_service(service, launch, cancel, executable).await?;
    match started
        .connection
        .request(ENVIRONMENT_ADD_METHOD, &environment_add)
        .await
    {
        Ok(_added) => Ok(started),
        Err(error) => Err(StartFailure {
            error,
            process: started.process.map(Box::new),
        }),
    }
}

// The relay of `service`, reading its conversations' sessions and asking its planned restart when
// its executor ends, so the next start brings a new one up.
fn compose_exec_relay(service: &Arc<CodexService>) -> Arc<CodexExecRelay> {
    let threads = Arc::downgrade(service);
    let restarts = Arc::downgrade(service);
    CodexExecRelay::new(
        Arc::clone(&service.dependencies().exec_relay),
        Arc::new(move |thread_id: &str| {
            let service = threads.upgrade()?;
            let threads = service.lock_threads();
            Some(RelayedThread {
                session_id: *threads.session_for(thread_id)?,
                is_side_question: threads.is_side_question(thread_id),
            })
        }),
        Arc::new(move || {
            if let Some(service) = restarts.upgrade() {
                service.request_planned_restart();
            }
        }),
    )
}

// The daemon's own child: launched with the shared switches and the service's own, dialed once
// it listens.
async fn start_account_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let process_launch = compose_launch(
        service,
        executable,
        service.launch_config_overrides(),
        service.socket_path(),
    )
    .await?;
    let managed = start_managed_codex_service(&service.dependencies().spawner, process_launch)
        .await
        .map_err(|error| start_failed("The Codex service could not be started.", error))?;
    let opened = connect(
        service,
        service.socket_path(),
        launch,
        CodexSocketWait::UntilListening,
        Some(managed.exited()),
        cancel,
    )
    .await;
    let process = Some(CodexServiceProcess::Managed(managed));
    let started = async {
        let (connection, reply) = opened?;
        let version = read_service_version(&reply, executable)?;
        let physical_socket = read_physical_socket(service.socket_path()).await?;
        Ok::<_, CodexError>((connection, version, physical_socket))
    }
    .await;
    match started {
        Ok((connection, version, physical_socket)) => Ok(StartedService {
            kind: CodexServiceKind::Account,
            process,
            connection,
            version,
            physical_socket,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure {
            error,
            process: process.map(Box::new),
        }),
    }
}

/// Dials the service's socket at `socket` under the ticket `dial` and opens the connection,
/// within the start's deadline and ended early by `exit`, the process's end, or `cancel`. Answers
/// the connection and its `initialize` reply.
pub(super) async fn connect(
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
        service.start_connection();
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

/// Every conversation the service has loaded, read page by page. Fails as a page's request does,
/// and with `CodexError::Transport` for a reply that is not a page or a cursor past the bound.
pub(crate) async fn read_codex_loaded_threads(
    connection: &CodexAppServerConnection,
) -> Result<Vec<String>, CodexError> {
    let mut thread_ids = Vec::new();
    let mut cursor = None;
    for _page in 0..LOADED_THREADS_PAGE_BOUND {
        let reply = connection
            .request(
                THREAD_LOADED_LIST_METHOD,
                &ThreadLoadedListParams {
                    cursor,
                    limit: Some(LOADED_THREADS_PAGE_LIMIT),
                },
            )
            .await?;
        let page = read_codex_object::<LoadedThreadsPage>(reply.get()).ok_or_else(|| {
            CodexError::Transport {
                detail: format!(
                    "The Codex service's \"{THREAD_LOADED_LIST_METHOD}\" reply is not a page."
                ),
                cause: None,
            }
        })?;
        thread_ids.extend(
            page.data
                .iter()
                .filter_map(|id| serde_json::from_str::<String>(id.get()).ok()),
        );
        match page.next_cursor.filter(|next| !next.is_empty()) {
            Some(next) => cursor = Some(next),
            None => return Ok(thread_ids),
        }
    }
    Err(CodexError::Transport {
        detail: format!(
            "The Codex service's \"{THREAD_LOADED_LIST_METHOD}\" kept naming another page past \
             {LOADED_THREADS_PAGE_BOUND}."
        ),
        cause: None,
    })
}

/// The version the service reported in its `initialize` reply, with the build resolved at its
/// start, checked against what a binding row stores. Fails with `CodexError::Transport` when the
/// report passes those bounds.
pub(super) fn read_service_version(
    reply: &RawValue,
    executable: &ResolvedProviderExecutable,
) -> Result<SpawnedProviderVersionReading, CodexError> {
    let user_agent = read_codex_object::<CodexInitializeReply>(reply.get())
        .unwrap_or_default()
        .user_agent;
    let report = match read_reported_version(user_agent.as_deref(), CODEX_CLIENT_NAME) {
        ReportedVersionReading::Version(version) => parse_cli_version_report(&version),
        ReportedVersionReading::UnreadableReply(text) => DriverCliVersionReport {
            raw_version: text,
            parsed_version: None,
        },
    };
    check_cli_version_report(DESCRIPTOR.provider_id(), &report).map_err(|error| {
        CodexError::Transport {
            detail: "The Codex service reported no version a binding can keep.".to_owned(),
            cause: Some(Box::new(error)),
        }
    })?;
    Ok(SpawnedProviderVersionReading {
        resolved_executable_path: executable.resolved_executable_path.clone(),
        report,
    })
}

// The launch of a service on the native program the build runs, with the launcher's variables
// set, in the dedicated empty working folder.
async fn compose_launch(
    service: &CodexService,
    executable: &ResolvedProviderExecutable,
    additional_config_overrides: Vec<String>,
    launch_socket: &Path,
) -> Result<CodexProcessLaunch, StartFailure> {
    let arguments = compose_codex_service_arguments(&CodexServiceCommandLineInput {
        listen_address: service.listen_address(launch_socket),
        additional_config_overrides,
    });
    Ok(
        compose_codex_native_launch(&service.dependencies().data_folder, executable, arguments)
            .await?,
    )
}

/// The launch of `executable`'s native Codex program, never the npm launcher, with `arguments`
/// after the leading arguments the build's own start carries, the launcher's variables set, in the
/// dedicated empty working folder under `data_folder`. Fails with `CodexError::Transport` when the
/// program cannot be found or the folder made.
pub(crate) async fn compose_codex_native_launch(
    data_folder: &Path,
    executable: &ResolvedProviderExecutable,
    arguments: Vec<String>,
) -> Result<CodexProcessLaunch, CodexError> {
    let not_found = |error: Box<dyn std::error::Error + Send + Sync>| CodexError::Transport {
        detail: "Codex's program could not be found.".to_owned(),
        cause: Some(error),
    };
    let start = executable.start.clone();
    let environment = executable.environment.clone();
    let native =
        tokio::task::spawn_blocking(move || resolve_codex_native_program(&start, &environment))
            .await
            .map_err(|error| not_found(Box::new(error)))?
            .map_err(|error| not_found(Box::new(error)))?;
    let mut launch_arguments: Vec<String> = if native.program == executable.start.program {
        executable
            .start
            .leading_arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    } else {
        Vec::new()
    };
    launch_arguments.extend(arguments);
    let mut environment = executable.environment.clone();
    native.set_launcher_environment(&mut environment);
    let working_folder: PathBuf = data_folder.join(CODEX_SERVICE_WORKING_FOLDER);
    create_private_folder(&working_folder).map_err(|error| CodexError::Transport {
        detail: "The Codex service's folder could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    Ok(CodexProcessLaunch {
        program: native.program,
        arguments: launch_arguments,
        environment,
        working_folder,
    })
}

async fn take_start_lock(
    codex_home: &std::path::Path,
    remaining: Duration,
) -> Result<CodexStartLock, StartFailure> {
    take_codex_start_lock(codex_home, remaining)
        .await
        .map_err(|error| start_failed("Codex's start lock on the folder was not free.", error))
}

// Where the socket at `socket` really is: the link's target, or `socket` itself where it is no
// link. Fails with the link's read error, since a socket recorded wrong leaves the home's link on
// nothing later.
async fn read_physical_socket(socket: &Path) -> Result<PathBuf, CodexError> {
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

/// A start's failure for `detail`, caused by `error`, with nothing launched to tear down.
pub(super) fn start_failed(
    detail: &str,
    error: impl std::error::Error + Send + Sync + 'static,
) -> StartFailure {
    StartFailure::from(CodexError::Transport {
        detail: detail.to_owned(),
        cause: Some(Box::new(error)),
    })
}

#[cfg(test)]
mod tests;
