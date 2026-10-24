//! The terminal service's start, on the person's own Codex folder with terminal reach on: it
//! clears a link that would block a plain `codex`; the service's first start then settles every
//! record a former daemon left, joining the running service that holds the home's link or one it
//! points the link back at and draining the rest, while a later start reads only its own records.
//! With a draining service holding the home's own socket, it launches beside it on a socket of its
//! own and moves the home's link there. It otherwise joins Codex's own managed daemon while a
//! conversation is loaded on it and stops it once none is, joins a listener no pid file names as
//! it is, and otherwise starts the lasting service under Codex's start lock, with the daemon's two
//! hooks, trusted before any conversation, while the daemon's program dispatches its hook mode. A
//! planned restart's second service ends what its own ended process left before it starts again,
//! and points the home's link back at itself before it lets go of Codex's start lock.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::value::RawValue;
use sidekicks_platforms::replace_socket_link;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::service::command_line::{
    LastingServiceVerdict, TerminalServiceHooks, compare_daemon_hook_commands,
    read_terminal_service_hooks,
};
use crate::provider::driver::codex::service::home::CodexServiceKind;
use crate::provider::driver::codex::service::managed_daemon::stop_codex_managed_daemon;
use crate::provider::driver::codex::service::process::{
    LastingCodexService, start_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::registry::own_socket_path;
use crate::provider::driver::codex::service::socket_link::{
    clear_blocking_socket_link, is_listening, restore_socket_link,
};
use crate::provider::driver::codex::service::start_lock::CodexStartLock;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::start::kept_records::{
    KeptRecordsOutcome, lock_record, on_record, reconcile_kept_records, retire_kept_record,
    settle_own_records,
};
use crate::provider::driver::codex::service::supervisor::start::{
    CodexServiceProcess, StartFailure, StartedService, compose_launch, connect,
    read_codex_loaded_threads, read_physical_socket, read_service_version, start_failed,
    take_start_lock,
};
use crate::provider::driver::codex::service::trust::{list_codex_hooks, trust_codex_daemon_hooks};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::codex::transport::socket::CodexSocketWait;
use crate::provider::service_log::provider_service_log_file;
use crate::provider::spawned_version::ResolvedProviderExecutable;

/// Starts the terminal service on the person's own Codex folder under the start ticket `launch`;
/// `cancel` stands the start down, and `start_lock` is Codex's start lock, held from the stop of
/// the managed daemon this start takes the place of.
pub(super) async fn start_terminal_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    start_lock: Option<CodexStartLock>,
) -> Result<StartedService, StartFailure> {
    let dependencies = service.dependencies();
    let codex_home = service.home().codex_home.clone();
    let socket = service.socket_path().to_owned();
    let record_file =
        LastingServiceRecordFile::of_socket(&dependencies.data_folder, &codex_home, &socket)
            .map_err(|error| {
                start_failed("The Codex service's record could not be named.", error)
            })?;
    let locked = lock_record(record_file).await?;
    let deadline = tokio::time::Instant::now() + dependencies.startup_timeout;
    // A planned restart's second service, on a socket of its own and a record of its own: the
    // first may still run beside it. Its crash restart first ends what its ended process left.
    if !service.socket.is_home_socket() {
        retire_kept_record(&locked, &socket).await?;
        let start_lock = take_start_lock(&codex_home, dependencies.startup_timeout).await?;
        return launch_terminal_service(
            service, launch, cancel, executable, start_lock, &locked, &socket,
        )
        .await;
    }
    // Codex's managed daemon was stopped under the lock this start still holds.
    if let Some(start_lock) = start_lock {
        return launch_terminal_service(
            service, launch, cancel, executable, start_lock, &locked, &socket,
        )
        .await;
    }
    if let Err(error) = clear_blocking_socket_link(&socket).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            socket = %socket.display(),
            "the Codex folder's socket link could not be checked"
        );
    }
    // Only the service's first start finds again what a former daemon left; a later one, whose
    // process came up before, reads only its own records.
    let kept = if service.physical_socket().is_some() {
        settle_own_records(service, &locked, deadline).await?
    } else {
        reconcile_kept_records(service, &locked, deadline).await?
    };
    match kept {
        KeptRecordsOutcome::Join {
            lasting,
            record_file,
            physical_socket,
        } => {
            return join_former_service(
                service,
                launch,
                cancel,
                executable,
                *lasting,
                record_file,
                physical_socket,
            )
            .await;
        }
        KeptRecordsOutcome::LaunchBeside => {
            return launch_beside(service, launch, cancel, executable, &locked, deadline).await;
        }
        // On the home's own socket, the home's link is the one Codex makes there.
        KeptRecordsOutcome::LaunchOnHome => service.set_holds_home_link(false),
    }
    let start_lock = loop {
        if cancel.is_cancelled() {
            return Err(StartFailure::from(CodexError::Transport {
                detail: "The Codex service's start was stood down.".to_owned(),
                cause: None,
            }));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(StartFailure::from(CodexError::Transport {
                detail: format!(
                    "The Codex folder's socket was not free within {:?} of the start.",
                    dependencies.startup_timeout
                ),
                cause: None,
            }));
        }
        if is_listening(&socket).await.map_err(socket_unreached)? {
            // Something answers that is not the daemon's: Codex's own managed daemon, or a
            // service no pid file names.
            let (connection, reply) = connect(
                service,
                &socket,
                launch,
                CodexSocketWait::Never,
                None,
                cancel,
            )
            .await?;
            if !read_codex_loaded_threads(&connection).await?.is_empty() {
                return join_listener(connection, &reply, executable, &socket).await;
            }
            let start_lock = take_start_lock(&codex_home, remaining).await?;
            let is_stopped = stop_codex_managed_daemon(&codex_home, &socket, &start_lock)
                .await
                .map_err(|error| {
                    start_failed(
                        "Codex's managed daemon on the folder could not be stopped.",
                        error,
                    )
                })?;
            // No pid file names the listener, so nothing the daemon may stop holds the socket.
            if !is_stopped {
                return join_listener(connection, &reply, executable, &socket).await;
            }
            close_quietly(&connection).await;
            break start_lock;
        }
        let start_lock = take_start_lock(&codex_home, remaining).await?;
        // Codex's updater holds the lock across a restart of its own, so a service may listen
        // now: that is the managed daemon again.
        if is_listening(&socket).await.map_err(socket_unreached)? {
            drop(start_lock);
            continue;
        }
        break start_lock;
    };
    launch_terminal_service(
        service, launch, cancel, executable, start_lock, &locked, &socket,
    )
    .await
}

// With a draining service holding the home's own socket until its running replies finish,
// launches beside it on a socket of its own, its record kept beside the home's under the same
// hold, so nothing waits on the drain; the launch then moves the home's link onto it.
async fn launch_beside(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    locked: &Arc<LockedServiceRecord>,
    deadline: tokio::time::Instant,
) -> Result<StartedService, StartFailure> {
    let codex_home = &service.home().codex_home;
    let socket = own_socket_path(codex_home).map_err(|error| {
        start_failed("The Codex service's own socket could not be named.", error)
    })?;
    let record_file = LastingServiceRecordFile::of_socket(
        &service.dependencies().data_folder,
        codex_home,
        &socket,
    )
    .map_err(|error| start_failed("The Codex service's record could not be named.", error))?;
    let beside = Arc::new(locked.sibling(record_file));
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let start_lock = take_start_lock(codex_home, remaining).await?;
    launch_terminal_service(
        service, launch, cancel, executable, start_lock, &beside, &socket,
    )
    .await
}

// A service already listening on the folder's socket, joined as it is.
async fn join_listener(
    connection: Arc<CodexAppServerConnection>,
    reply: &RawValue,
    executable: &ResolvedProviderExecutable,
    socket: &Path,
) -> Result<StartedService, StartFailure> {
    Ok(StartedService {
        kind: CodexServiceKind::Joined,
        process: None,
        version: read_service_version(reply, executable)?,
        physical_socket: read_physical_socket(socket).await?,
        is_restart_owed: false,
        connection,
    })
}

// A lasting service a former daemon left, joined on `physical_socket`, where its record says its
// socket really is, so the join reaches that record's service whatever the home's link names; its
// hooks are compared with the ones this daemon would start it with. A join the service fails, in
// its dial and answer, its hook list or its version, hands it back with the failure, so the
// start's teardown stops it and removes its record; a failure on the daemon's own side leaves it
// running in its record.
async fn join_former_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    lasting: LastingCodexService,
    record_file: LastingServiceRecordFile,
    physical_socket: PathBuf,
) -> Result<StartedService, StartFailure> {
    let hooks = read_terminal_service_hooks().map_err(|error| {
        start_failed("The daemon's hook commands could not be composed.", error)
    })?;
    let joined = async {
        let (connection, reply) = connect(
            service,
            &physical_socket,
            launch,
            CodexSocketWait::Never,
            None,
            cancel,
        )
        .await?;
        let listed = list_codex_hooks(&connection).await?;
        let is_restart_owed =
            compare_daemon_hook_commands(&listed, &hooks) == LastingServiceVerdict::Restart;
        let version = read_service_version(&reply, executable)?;
        Ok::<_, CodexError>((connection, version, is_restart_owed))
    }
    .await;
    let process = Some(CodexServiceProcess::Lasting {
        service: lasting,
        record_file,
    });
    match joined {
        Ok((connection, version, is_restart_owed)) => Ok(StartedService {
            kind: CodexServiceKind::Terminal,
            process,
            connection,
            version,
            physical_socket,
            is_restart_owed,
        }),
        Err(error) => Err(StartFailure { error, process }),
    }
}

// Launches the lasting service on `launch_socket` under Codex's start lock and the record's, keeps
// its record, and lets go of the start lock once it listens, the home's link moved onto a service
// launched beside a draining one and pointed back at a service that holds it; its hooks, while the
// daemon runs any, are trusted before any conversation.
async fn launch_terminal_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    start_lock: CodexStartLock,
    locked: &Arc<LockedServiceRecord>,
    launch_socket: &Path,
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
    let hook_commands = match read_terminal_service_hooks()
        .map_err(|error| start_failed("The daemon's hook commands could not be composed.", error))?
    {
        TerminalServiceHooks::NoHooks => None,
        TerminalServiceHooks::Daemon(hook_commands) => Some(hook_commands),
        TerminalServiceHooks::ProgramReplaced => {
            return Err(StartFailure::from(CodexError::Transport {
                detail: "The daemon's own program was replaced, so its hooks cannot run it."
                    .to_owned(),
                cause: None,
            }));
        }
    };
    let mut overrides = dependencies.additional_config_overrides.clone();
    if let Some(hook_commands) = &hook_commands {
        overrides.extend(hook_commands.config_overrides());
    }
    let process_launch = compose_launch(service, executable, overrides, launch_socket).await?;
    // A start stood down before its launch launches nothing.
    if cancel.is_cancelled() {
        return Err(StartFailure::from(CodexError::Transport {
            detail: "The Codex service's start was stood down.".to_owned(),
            cause: None,
        }));
    }
    let log_file = provider_service_log_file(
        &dependencies.logs_folder,
        &DESCRIPTOR.provider_id(),
        codex_home,
    )
    .map_err(|error| start_failed("The Codex service's log could not be named.", error))?;
    let lasting = start_lasting_codex_service(&dependencies.spawner, process_launch, &log_file)
        .await
        .map_err(|error| start_failed("The Codex service could not be started.", error))?;
    let record_file = locked.file().clone();
    let launched = LastingServiceRecord::launched(lasting.record().clone());
    if let Err(error) = on_record(locked, move |locked| locked.write(&launched)).await {
        return Err(StartFailure {
            error: CodexError::Transport {
                detail: "The Codex service's record could not be kept.".to_owned(),
                cause: Some(Box::new(error)),
            },
            process: Some(CodexServiceProcess::Lasting {
                service: lasting,
                record_file,
            }),
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
    let answered = LastingServiceRecord::launched(lasting.record().clone());
    let process = Some(CodexServiceProcess::Lasting {
        service: lasting,
        record_file,
    });
    let trusted = async {
        let (connection, reply) = opened?;
        let physical_socket = read_physical_socket(launch_socket).await?;
        // Kept under the same hold, so a later daemon finds the socket the home's link names.
        let answered = LastingServiceRecord {
            physical_socket: Some(physical_socket.clone()),
            ..answered
        };
        on_record(locked, move |locked| locked.write(&answered))
            .await
            .map_err(|error| CodexError::Transport {
                detail: "The Codex service's record could not be kept.".to_owned(),
                cause: Some(Box::new(error)),
            })?;
        if let Some(hook_commands) = &hook_commands {
            trust_codex_daemon_hooks(&connection, hook_commands).await?;
        }
        let version = read_service_version(&reply, executable)?;
        // Only a start that succeeded takes the link. A plain `codex` that waited on Codex's
        // start lock re-reads the link once it is free, so the link names this service first.
        if launch_socket != service.socket_path() {
            move_home_link_beside(service, &physical_socket).await?;
        } else if service.holds_home_link() {
            restore_held_socket_link(service, &physical_socket).await;
        }
        // Held only for the seconds the start takes.
        drop(start_lock);
        Ok::<_, CodexError>((connection, version, physical_socket))
    }
    .await;
    match trusted {
        Ok((connection, version, physical_socket)) => Ok(StartedService {
            kind: CodexServiceKind::Terminal,
            process,
            connection,
            version,
            physical_socket,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure { error, process }),
    }
}

// Moves the home's link off the draining service holding the home's own socket onto the service
// launched beside it, which then holds it. Fails as the move does.
async fn move_home_link_beside(
    service: &CodexService,
    physical_socket: &Path,
) -> Result<(), CodexError> {
    let home_socket = service.socket.home_socket.clone();
    let target = physical_socket.to_owned();
    tokio::task::spawn_blocking(move || replace_socket_link(&home_socket, &target))
        .await
        .map_err(io::Error::other)
        .and_then(|moved| moved)
        .map_err(|error| CodexError::Transport {
            detail: "The Codex folder's socket link could not be moved onto its service."
                .to_owned(),
            cause: Some(Box::new(error)),
        })?;
    service.set_holds_home_link(true);
    Ok(())
}

// Points the home's link back at the restarted service that holds it, on `physical_socket`. A
// service answering on the link in its place, Codex's managed daemon in use, keeps it, and this
// service lets go of it; a failed move is reported, the service then unreached by a plain `codex`.
async fn restore_held_socket_link(service: &CodexService, physical_socket: &Path) {
    match restore_socket_link(&service.socket.home_socket, physical_socket, &[]).await {
        Ok(true) => {}
        Ok(false) => service.set_holds_home_link(false),
        Err(error) => CodexTransportDiagnostic::HomeLinkRestoreFailed {
            codex_home: service.home().codex_home.clone(),
            error: Box::new(error),
        }
        .report(),
    }
}

// A failure to reach the folder's socket other than nothing listening there, which fails the
// start.
fn socket_unreached(error: io::Error) -> StartFailure {
    start_failed("The Codex folder's socket could not be reached.", error)
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
