//! The socket a start answers on while it repairs the database file, which on a large file takes
//! minutes: it binds before the repair and answers every handshake that carries its session token
//! with `daemon.repairing`, with how far the repair has come where it can say, so a client knows
//! the daemon is alive and waits for it rather than ending it as one that never answered. It
//! serves the lifecycle verbs too, so a stop or a restart asked for over the socket ends the repair
//! as the system's stop request does; it serves nothing else, and goes once the repair has ended,
//! so the start binds its own socket over the repaired file.

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::recovery::DaemonRepairProgress;
use sidekicks_platforms::DaemonRunFolder;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::bootstrap::secure_defaults::SecureDefaults;
use crate::cleanup_failures::CleanupFailures;
use crate::daemon::lifecycle_methods::{LifecycleMethodsDeps, register_lifecycle_methods};
use crate::daemon::run_folder::{
    RunFolderError, bind_socket, mint_session_token, prepare_run_folder,
};
use crate::ipc::caller_process::contract::CallerProcessReader;
use crate::ipc::caller_process::descent::CallerCheck;
use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::ipc::local_gateway::{
    GatewayServices, LocalGateway, SupervisionDisconnectReason, SupervisionHooks,
};
use crate::ipc::protocol_negotiation::ProtocolNegotiator;
use crate::ipc::registry::{Dispatch, MethodRegistryBuilder, RegistrationError, TransportId};
use crate::ipc::stream::subscriptions::Subscriptions;
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::database_file::repair::{
    DatabaseFileRepair, DatabaseFileRepairError, DatabaseFileRepairOptions, LeftoverFile,
    prepare_database_file_repair, repair_damaged_file,
};

/// How a start's repair of the database file ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DatabaseFileRepairEnd {
    /// The file needed no repair, or was repaired, or stays damaged with its record for the next
    /// start: the start goes on.
    Continued,
    /// A stop came, over the socket or from the system, so the start ends.
    Stopped,
}

/// Why the repair could not run.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepairingSocketError {
    /// The repair could not start, or the ready file could not be put in place.
    #[error(transparent)]
    Repair(#[from] DatabaseFileRepairError),
    /// The session token could not be minted.
    #[error("the repairing socket's session token could not be minted")]
    Token(#[source] getrandom::Error),
    /// A method was already registered.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
    /// The run folder could not be prepared or the socket bound, another daemon running there
    /// among the reasons.
    #[error(transparent)]
    RunFolder(#[from] RunFolderError),
}

/// What the repair runs with and where its socket binds.
pub(crate) struct RepairingSocketDeps<'a> {
    /// The repair's files and programs.
    pub(crate) options: &'a DatabaseFileRepairOptions<'a>,
    /// Where the person keeps backups, when they keep any.
    pub(crate) backup_folder: Option<&'a Path>,
    /// The run folder the socket and token go in.
    pub(crate) run_folder: &'a DaemonRunFolder,
    /// The checked socket path the gateway binds.
    pub(crate) secure_defaults: &'a SecureDefaults,
    /// Reads a connecting process's parents, responsible process and signature.
    pub(crate) caller_process_reader: Arc<dyn CallerProcessReader>,
    /// The system's stop request, which ends the repair as a stop over the socket does.
    pub(crate) stop: &'a CancellationToken,
}

/// Finishes a replacement a crash cut short and, when a run recorded damage, repairs the file
/// while the run folder's socket answers that the daemon is repairing. Logs each file the repair
/// could not remove, and a repair that failed with only what the repair has not logged already.
/// Fails with [`RepairingSocketError`] when the repair cannot run, its socket cannot be bound or a
/// daemon answers there already.
#[expect(
    dead_code,
    reason = "the daemon's start repairs the database file through it before opening it"
)]
pub(crate) async fn repair_database_file_while_answering(
    deps: RepairingSocketDeps<'_>,
) -> Result<DatabaseFileRepairEnd, RepairingSocketError> {
    let Some(damage) = prepare_database_file_repair(deps.options).await? else {
        return Ok(DatabaseFileRepairEnd::Continued);
    };
    let (progress_sender, progress) = watch::channel(None);
    let repair_stop = deps.stop.child_token();
    let gateway = bind_repairing_socket(&deps, progress, repair_stop.clone()).await?;
    let repaired = repair_damaged_file(
        deps.options,
        &damage,
        deps.backup_folder,
        &progress_sender,
        &repair_stop,
    )
    .await;
    gateway.stop().await;
    let outcome = match repaired {
        Ok(outcome) => outcome,
        // A stop can cut short the removal of an earlier repair's files; it is still a stop.
        Err(DatabaseFileRepairError::Leftover(leftovers)) if repair_stop.is_cancelled() => {
            log_leftovers(std::slice::from_ref(leftovers.original()));
            log_leftover_failures(&leftovers);
            return Ok(DatabaseFileRepairEnd::Stopped);
        }
        Err(error) => return Err(error.into()),
    };
    Ok(match outcome {
        DatabaseFileRepair::Repaired { leftovers, .. } => {
            log_leftovers(&leftovers);
            DatabaseFileRepairEnd::Continued
        }
        DatabaseFileRepair::Unrepaired { failure, .. } => {
            // The repair logged why it failed and where the copy aside is; what is left to say is
            // which of its files stayed.
            log_leftover_failures(&failure);
            DatabaseFileRepairEnd::Continued
        }
        DatabaseFileRepair::Stopped { leftovers } => {
            log_leftovers(&leftovers);
            DatabaseFileRepairEnd::Stopped
        }
    })
}

// Binds the socket answering `daemon.repairing` with the last progress `progress` holds, and the
// lifecycle verbs, whose stop cancels `repair_stop`.
async fn bind_repairing_socket(
    deps: &RepairingSocketDeps<'_>,
    progress: watch::Receiver<Option<DaemonRepairProgress>>,
    repair_stop: CancellationToken,
) -> Result<LocalGateway, RepairingSocketError> {
    let session_token = mint_session_token().map_err(RepairingSocketError::Token)?;
    // No terminal runs and no provider service is held while the file is repaired.
    let caller_check = CallerCheck::new(
        Arc::clone(&deps.caller_process_reader),
        Arc::new(Default::default),
        Arc::new(ProviderServiceProcesses::new(Arc::clone(
            &deps.caller_process_reader,
        ))),
    );
    let negotiator = ProtocolNegotiator::new(session_token.clone(), caller_check.admission_check());
    let mut builder = MethodRegistryBuilder::new();
    negotiator
        .register_repairing_handshake(&mut builder, Arc::new(move || progress.borrow().clone()))?;
    register_lifecycle_methods(
        &mut builder,
        &LifecycleMethodsDeps {
            // Nothing is open to write while the file is repaired.
            flush: Arc::new(|| async { Ok(()) }.boxed()),
            accept_stop: Arc::new(move || repair_stop.cancel()),
        },
    )?;
    let registry = Arc::new(builder.freeze());
    let services = GatewayServices {
        device_id: None,
        dispatch: Arc::new(negotiator.gate(
            Arc::clone(&registry) as Arc<dyn Dispatch>,
            Arc::clone(&registry),
        )),
        registry,
        negotiator,
        subscriptions: Subscriptions::new(Arc::new(DatabaseDamageWatch::new())),
        hooks: Arc::new(RepairingSocketHooks),
    };
    prepare_run_folder(deps.run_folder).await?;
    let caller_process_reader = Arc::clone(&deps.caller_process_reader);
    Ok(bind_socket(
        || LocalGateway::start(services, caller_process_reader, deps.secure_defaults),
        deps.run_folder,
        session_token,
    )
    .await?)
}

fn log_leftovers(leftovers: &[LeftoverFile]) {
    for leftover in leftovers {
        tracing::warn!(
            error = leftover as &(dyn Error + 'static),
            "a file of the database file's repair stays beside it"
        );
    }
}

fn log_leftover_failures<Failure>(failures: &CleanupFailures<Failure, LeftoverFile>) {
    log_leftovers(failures.cleanup_failures());
}

// Logs the listener's and each connection's failures; a connection's end needs nothing more.
struct RepairingSocketHooks;

impl SupervisionHooks for RepairingSocketHooks {
    fn on_disconnect(&self, _transport: TransportId, _reason: SupervisionDisconnectReason) {}

    fn on_error(&self, transport: TransportId, error: &(dyn Error + 'static)) {
        tracing::warn!(
            transport = transport.0,
            error,
            "a connection to the repairing socket failed"
        );
    }

    fn on_listener_error(&self, error: &(dyn Error + 'static)) {
        tracing::warn!(error, "the repairing socket's listener failed");
    }
}
