//! How each kind of Codex service starts. A service on an account home is the daemon's own child,
//! dialed once it listens. On the person's own Codex folder with terminal reach on, the start
//! clears a link that would block a plain `codex`, joins the lasting service a former daemon left
//! when its record pins it, ends what such a service left once it is gone, joins Codex's own
//! managed daemon while a conversation is loaded on it and stops it once none is, and otherwise
//! starts the lasting service under Codex's start lock with the daemon's two hooks, trusted before
//! any conversation.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_platforms::{
    ProcessRecord, RunningProgramPath, create_private_folder, read_running_program_path,
};
use tokio_util::sync::CancellationToken;

use crate::provider::driver::ReportedVersionReading;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::ThreadLoadedListParams;
use crate::provider::driver::codex::native_program::resolve_codex_native_program;
use crate::provider::driver::codex::service::command_line::{
    CodexServiceCommandLineInput, LastingServiceVerdict, compare_daemon_hook_commands,
    compose_codex_service_arguments, compose_daemon_hook_commands,
};
use crate::provider::driver::codex::service::home::{CodexHomeKind, CodexServiceKind};
use crate::provider::driver::codex::service::managed_daemon::stop_codex_managed_daemon;
use crate::provider::driver::codex::service::process::{
    CodexProcessLaunch, CodexServiceExit, LastingCodexService, ManagedCodexService,
    codex_lasting_service_environment_entry, repin_lasting_codex_service,
    start_lasting_codex_service, start_managed_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::socket_link::clear_blocking_socket_link;
use crate::provider::driver::codex::service::start_lock::{CodexStartLock, take_codex_start_lock};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::trust::{list_codex_hooks, trust_codex_daemon_hooks};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::{
    CodexAppServerConnection, open_codex_connection, read_codex_object,
};
use crate::provider::driver::codex::transport::socket::{
    CodexSocketWait, dial_codex_service_socket,
};
use crate::provider::driver::codex::version::{
    CODEX_CLIENT_NAME, CodexInitializeReply, read_reported_version,
};
use crate::provider::driver::contract::DriverCliVersionReport;
use crate::provider::output_validation::check_cli_version_report;
use crate::provider::service_log::provider_service_log_file;
use crate::provider::spawned_version::{
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

/// A service process the daemon started or re-pinned.
pub(crate) enum CodexServiceProcess {
    /// The daemon's own child on an account home.
    Managed(ManagedCodexService),
    /// The lasting service on the person's own Codex folder.
    Lasting(LastingCodexService),
}

impl CodexServiceProcess {
    /// The process's exit, `None` for a lasting service a former daemon started, whose end reads
    /// from its connection's end.
    pub(super) fn exited(&self) -> Option<CodexServiceExit> {
        match self {
            Self::Managed(managed) => Some(managed.exited()),
            Self::Lasting(lasting) => lasting.exited(),
        }
    }

    /// The process's id, when the system gave one.
    pub(super) fn process_id(&self) -> Option<u32> {
        match self {
            Self::Managed(managed) => managed.process_id(),
            Self::Lasting(lasting) => Some(lasting.record().id()),
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
    /// Whether a terminal service a former daemon left runs other hooks than this daemon's, so a
    /// planned restart is owed once it is up.
    pub(super) is_restart_owed: bool,
}

/// A start that failed, with the process it launched, which the runner tears down.
pub(super) struct StartFailure {
    /// Why.
    pub(super) error: CodexError,
    /// What it launched, if anything.
    pub(super) process: Option<CodexServiceProcess>,
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
pub(super) async fn start_codex_service(
    service: Arc<CodexService>,
    launch: u64,
    cancel: CancellationToken,
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
        CodexHomeKind::Account
        | CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: false,
        } => start_account_service(&service, launch, &cancel, &executable).await,
        CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: true,
        } => start_terminal_service(&service, launch, &cancel, &executable).await,
    }
}

// The daemon's own child: launched with the shared switches alone, dialed once it listens.
async fn start_account_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let process_launch = compose_launch(
        service,
        executable,
        service.dependencies().additional_config_overrides.clone(),
    )
    .await?;
    let managed = start_managed_codex_service(&service.dependencies().spawner, process_launch)
        .await
        .map_err(|error| start_failed("The Codex service could not be started.", error))?;
    let opened = connect(
        service,
        launch,
        CodexSocketWait::UntilListening,
        Some(managed.exited()),
        cancel,
    )
    .await;
    let process = Some(CodexServiceProcess::Managed(managed));
    match opened
        .and_then(|(connection, reply)| Ok((connection, read_service_version(&reply, executable)?)))
    {
        Ok((connection, version)) => Ok(StartedService {
            kind: CodexServiceKind::Account,
            process,
            connection,
            version,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure { error, process }),
    }
}

// Lets go of a former lasting service its record no longer pins: ends what it left running, then
// removes the record, so the fresh start that follows leaves no tree of the former one running.
async fn retire_former_service(
    locked: &LockedServiceRecord,
    record: ProcessRecord,
) -> Result<(), StartFailure> {
    let entry = codex_lasting_service_environment_entry();
    let ended = tokio::task::spawn_blocking(move || record.end_survivors(&entry)).await;
    if let Err(error) = ended.map_err(std::io::Error::other).and_then(|ended| ended) {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "what a former Codex service left running could not be ended"
        );
    }
    locked
        .remove()
        .map_err(|error| start_failed("The Codex service's record could not be removed.", error))
}

// The person's own Codex folder with terminal reach on.
async fn start_terminal_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let dependencies = service.dependencies();
    let codex_home = service.home().codex_home.clone();
    let socket = service.socket_path().to_owned();
    let record_file = LastingServiceRecordFile::of_home(&dependencies.data_folder, &codex_home)
        .map_err(|error| start_failed("The Codex service's record could not be named.", error))?;
    let locked = tokio::task::spawn_blocking(move || record_file.lock())
        .await
        .map_err(|error| start_failed("The Codex service's record lock failed.", error))?
        .map_err(|error| start_failed("The Codex service's record could not be locked.", error))?;
    // A planned restart's second service, on a socket of its own: the first still runs in the
    // record, so the second starts beside it and its record takes the first's place.
    if !service.socket.is_home_socket() {
        let start_lock = take_start_lock(&codex_home, dependencies.startup_timeout).await?;
        return launch_terminal_service(service, launch, cancel, executable, start_lock, &locked)
            .await;
    }
    if let Err(error) = clear_blocking_socket_link(&socket).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            socket = %socket.display(),
            "the Codex folder's socket link could not be checked"
        );
    }
    let kept = locked
        .read()
        .map_err(|error| start_failed("The Codex service's record could not be read.", error))?;
    if let Some(record) = kept {
        let repinned = repin_lasting_codex_service(record.clone())
            .map_err(|error| start_failed("The Codex service could not be found again.", error))?;
        match repinned {
            Some(lasting) => {
                return join_former_service(service, launch, cancel, executable, lasting).await;
            }
            None => retire_former_service(&locked, record).await?,
        }
    }
    let deadline = tokio::time::Instant::now() + dependencies.startup_timeout;
    let start_lock = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Ok((connection, reply)) =
            connect(service, launch, CodexSocketWait::Never, None, cancel).await
        {
            // Something answers that is not the daemon's: Codex's own managed daemon.
            if !read_codex_loaded_threads(&connection).await?.is_empty() {
                return Ok(StartedService {
                    kind: CodexServiceKind::Joined,
                    process: None,
                    connection,
                    version: read_service_version(&reply, executable)?,
                    is_restart_owed: false,
                });
            }
            close_quietly(&connection).await;
            let start_lock = take_start_lock(&codex_home, remaining).await?;
            stop_codex_managed_daemon(&codex_home, &socket, &start_lock)
                .await
                .map_err(|error| {
                    start_failed(
                        "Codex's managed daemon on the folder could not be stopped.",
                        error,
                    )
                })?;
            break start_lock;
        }
        let start_lock = take_start_lock(&codex_home, remaining).await?;
        // Codex's updater holds the lock across a restart of its own, so a service may listen
        // now: that is the managed daemon again.
        if sidekicks_platforms::connect_unix_domain_socket(&socket)
            .await
            .is_ok()
        {
            drop(start_lock);
            continue;
        }
        break start_lock;
    };
    launch_terminal_service(service, launch, cancel, executable, start_lock, &locked).await
}

// A lasting service a former daemon left: joined, its hooks compared with this daemon's.
async fn join_former_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    lasting: LastingCodexService,
) -> Result<StartedService, StartFailure> {
    let process = Some(CodexServiceProcess::Lasting(lasting));
    let joined = async {
        let (connection, reply) =
            connect(service, launch, CodexSocketWait::Never, None, cancel).await?;
        let listed = list_codex_hooks(&connection).await?;
        let daemon_program =
            read_running_program_path().map_err(|error| CodexError::Transport {
                detail: "The daemon's own program could not be read.".to_owned(),
                cause: Some(Box::new(error)),
            })?;
        let is_restart_owed = match &daemon_program {
            RunningProgramPath::OnDisk(path) => {
                let composed =
                    compose_daemon_hook_commands(path).map_err(|error| CodexError::Transport {
                        detail: "The daemon's hook commands could not be written.".to_owned(),
                        cause: Some(Box::new(error)),
                    })?;
                compare_daemon_hook_commands(&listed, &composed, &daemon_program)
                    == LastingServiceVerdict::Restart
            }
            RunningProgramPath::Replaced => true,
        };
        let version = read_service_version(&reply, executable)?;
        Ok::<_, CodexError>((connection, version, is_restart_owed))
    }
    .await;
    match joined {
        Ok((connection, version, is_restart_owed)) => Ok(StartedService {
            kind: CodexServiceKind::Terminal,
            process,
            connection,
            version,
            is_restart_owed,
        }),
        Err(error) => Err(StartFailure { error, process }),
    }
}

// Launches the lasting service under Codex's start lock and the record's, keeps its record, and
// lets go of the start lock once it listens; its hooks are trusted before any conversation.
async fn launch_terminal_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    start_lock: CodexStartLock,
    locked: &LockedServiceRecord,
) -> Result<StartedService, StartFailure> {
    let dependencies = service.dependencies();
    let codex_home = &service.home().codex_home;
    // Codex's managed daemon may have left a link to its ended socket.
    if let Err(error) = clear_blocking_socket_link(service.socket_path()).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "the Codex folder's socket link could not be checked"
        );
    }
    let daemon_program = match read_running_program_path() {
        Ok(RunningProgramPath::OnDisk(path)) => path,
        Ok(RunningProgramPath::Replaced) => {
            return Err(StartFailure::from(CodexError::Transport {
                detail: "The daemon's own program was replaced, so its hooks cannot run it."
                    .to_owned(),
                cause: None,
            }));
        }
        Err(error) => {
            return Err(start_failed(
                "The daemon's own program could not be read.",
                error,
            ));
        }
    };
    let hook_commands = compose_daemon_hook_commands(&daemon_program).map_err(|error| {
        StartFailure::from(CodexError::Transport {
            detail: "The daemon's hook commands could not be written.".to_owned(),
            cause: Some(Box::new(error)),
        })
    })?;
    let mut overrides = dependencies.additional_config_overrides.clone();
    overrides.extend(hook_commands.config_overrides());
    let process_launch = compose_launch(service, executable, overrides).await?;
    let log_file = provider_service_log_file(
        &dependencies.logs_folder,
        &DESCRIPTOR.provider_id(),
        codex_home,
    )
    .map_err(|error| start_failed("The Codex service's log could not be named.", error))?;
    let lasting = start_lasting_codex_service(&dependencies.spawner, process_launch, &log_file)
        .await
        .map_err(|error| start_failed("The Codex service could not be started.", error))?;
    if let Err(error) = locked.write(lasting.record()) {
        return Err(StartFailure {
            error: CodexError::Transport {
                detail: "The Codex service's record could not be kept.".to_owned(),
                cause: Some(Box::new(error)),
            },
            process: Some(CodexServiceProcess::Lasting(lasting)),
        });
    }
    let opened = connect(
        service,
        launch,
        CodexSocketWait::UntilListening,
        lasting.exited(),
        cancel,
    )
    .await;
    // Held only for the seconds the start takes.
    drop(start_lock);
    let process = Some(CodexServiceProcess::Lasting(lasting));
    let trusted = match opened {
        Ok((connection, reply)) => match trust_codex_daemon_hooks(&connection, &hook_commands)
            .await
            .and_then(|()| read_service_version(&reply, executable))
        {
            Ok(version) => Ok((connection, version)),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    match trusted {
        Ok((connection, version)) => Ok(StartedService {
            kind: CodexServiceKind::Terminal,
            process,
            connection,
            version,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure { error, process }),
    }
}

/// Dials the service's socket under the ticket `dial` and opens the connection, within the
/// start's deadline and ended early by `exit`, the process's end, or `cancel`. Answers the
/// connection and its `initialize` reply.
pub(super) async fn connect(
    service: &Arc<CodexService>,
    dial: u64,
    wait: CodexSocketWait,
    exit: Option<CodexServiceExit>,
    cancel: &CancellationToken,
) -> Result<(Arc<CodexAppServerConnection>, Box<RawValue>), CodexError> {
    let dependencies = service.dependencies();
    let startup_timeout = dependencies.startup_timeout;
    let opening = async {
        let (sender, receiver) = dial_codex_service_socket(
            service.socket_path(),
            wait,
            &dependencies.provider_services,
            cancel,
        )
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
pub(super) async fn read_codex_loaded_threads(
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

// The launch of a service on the native program the build runs, never the npm launcher, with the
// launcher's variables set, in the dedicated empty working folder.
async fn compose_launch(
    service: &CodexService,
    executable: &ResolvedProviderExecutable,
    additional_config_overrides: Vec<String>,
) -> Result<CodexProcessLaunch, StartFailure> {
    let start = executable.start.clone();
    let environment = executable.environment.clone();
    let native =
        tokio::task::spawn_blocking(move || resolve_codex_native_program(&start, &environment))
            .await
            .map_err(|error| start_failed("Codex's program could not be found.", error))?
            .map_err(|error| start_failed("Codex's program could not be found.", error))?;
    let mut arguments: Vec<String> = if native.program == executable.start.program {
        executable
            .start
            .leading_arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    } else {
        Vec::new()
    };
    arguments.extend(compose_codex_service_arguments(
        &CodexServiceCommandLineInput {
            listen_address: service.listen_address(),
            additional_config_overrides,
        },
    ));
    let mut environment = executable.environment.clone();
    native.set_launcher_environment(&mut environment);
    let working_folder: PathBuf = service
        .dependencies()
        .data_folder
        .join(CODEX_SERVICE_WORKING_FOLDER);
    create_private_folder(&working_folder)
        .map_err(|error| start_failed("The Codex service's folder could not be made.", error))?;
    Ok(CodexProcessLaunch {
        program: native.program,
        arguments,
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

// Closes a connection the start no longer needs; a failed close is logged.
async fn close_quietly(connection: &CodexAppServerConnection) {
    if let Err(error) = connection.close().await {
        tracing::debug!(
            error = &error as &(dyn std::error::Error + 'static),
            "a Codex connection the start let go of did not close cleanly"
        );
    }
}

fn start_failed(
    detail: &str,
    error: impl std::error::Error + Send + Sync + 'static,
) -> StartFailure {
    StartFailure::from(CodexError::Transport {
        detail: detail.to_owned(),
        cause: Some(Box::new(error)),
    })
}

#[cfg(all(test, unix))]
mod tests;
