//! The recovery services the start builds: the projection rebuild, the restart's settle, the
//! resumed runs' finalize, the stored data's methods and the startup recovery pass.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use sidekicks_contracts::machine::id::MachineId;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_queue::provider_session::resumed_runs::ResumedRunsIngress;
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::projection_rebuild::ProjectionRebuildService;
use sidekicks_recovery::restart_settle::{RestartSettle, RestartSettleDeps};
use sidekicks_recovery::resumed_runs::{ResumedRunsFinalize, ResumedRunsFinalizeDeps};
use sidekicks_recovery::startup::{StartupRecovery, StartupRecoveryDeps};
use sidekicks_shell::table::ShellTable;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::project::list_feed::ProjectListFeed;

use crate::daemon::artifact_methods::ArtifactMethods;
use crate::daemon::backup::run::Backups;
use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::process::database::DatabaseFile;
use crate::daemon::process::method_inputs::MethodInputsError;
use crate::daemon::process::projections::rebuild_projections;
use crate::daemon::process::providers::Providers;
use crate::daemon::process::repo_services::RepoServices;
use crate::daemon::process::session_services::SessionServices;
use crate::daemon::process::stored_data::{
    StoredDataMethods, StoredDataMethodsStart, build_stored_data_methods,
};

/// What the recovery services are built from: the handles the start keeps using afterward, lent,
/// and the ones the recovery pass takes, owned.
pub(super) struct RecoveryServiceStart<'start> {
    /// The open database file.
    pub(super) database: &'start DatabaseFile,
    /// The database's read pool.
    pub(super) reads: &'start Arc<DatabaseReadPool>,
    /// The database's writer, which the recovery pass takes.
    pub(super) writer: Arc<DatabaseWriter>,
    /// The session services.
    pub(super) session: &'start SessionServices,
    /// The repository services.
    pub(super) repo: &'start RepoServices,
    /// The providers, whose runs' postures a purge clears.
    pub(super) providers: &'start Providers,
    /// Every driver.
    pub(super) registry: &'start Arc<ProviderRegistry>,
    /// The artifact store, whose payloads a purge unlinks.
    pub(super) artifacts: &'start ArtifactMethods,
    /// The terminals' shells.
    pub(super) shells: &'start Arc<ShellTable>,
    /// The live projects list.
    pub(super) project_list_feed: &'start Arc<ProjectListFeed>,
    /// This machine's id.
    pub(super) machine_id: MachineId,
    /// The daemon's configuration.
    pub(super) configuration: &'start Arc<ConfigurationStore>,
    /// The daemon's one scheduler.
    pub(super) scheduler: &'start Arc<Scheduler>,
    /// The service's backups.
    pub(super) backups: &'start Arc<Backups>,
    /// The serving socket's record of mutating calls, set once its gate chain is built.
    pub(super) in_flight: Arc<OnceLock<Arc<InFlightMutations>>>,
    /// Starts the daemon's stop for the intent given.
    pub(super) accept_stop: &'start Arc<dyn Fn(DaemonStopIntent) + Send + Sync>,
    /// The daemon's data folder.
    pub(super) data_folder: &'start Path,
    /// The copy the recovery pass copies the store's files aside with.
    pub(super) copier: Arc<DatabaseFileCopier>,
}

/// The stored data's methods and the startup recovery pass, which share the projection rebuild
/// and the restart's settle.
pub(super) struct RecoveryServices {
    /// The retention, lifecycle and damaged-history methods' inputs.
    pub(super) stored: StoredDataMethods,
    /// The recovery pass, run once the socket is bound and before any follow of the log begins.
    pub(super) recovery: StartupRecovery,
}

/// Builds the projection rebuild and the restart's settle, registers the resumed runs' finalize,
/// then builds the stored data's methods and the recovery pass over them. Fails with
/// [`MethodInputsError::PortRegistration`] when the resumed runs' port was registered already.
pub(super) fn build_recovery_services(
    start: RecoveryServiceStart<'_>,
) -> Result<RecoveryServices, MethodInputsError> {
    let RecoveryServiceStart {
        database,
        reads,
        writer,
        session,
        repo,
        providers,
        registry,
        artifacts,
        shells,
        project_list_feed,
        machine_id,
        configuration,
        scheduler,
        backups,
        in_flight,
        accept_stop,
        data_folder,
        copier,
    } = start;
    let projection_rebuild = Arc::new(ProjectionRebuildService::new(
        Arc::clone(reads),
        Arc::clone(&writer),
        Arc::clone(&session.sessions),
        Arc::clone(&database.damage),
        rebuild_projections(),
    ));
    let restart_settle = Arc::new(RestartSettle::new(RestartSettleDeps {
        reads: Arc::clone(reads),
        appender: Arc::clone(&session.appender),
        run_engine: Arc::clone(&session.engine),
        approvals: Arc::clone(&session.approvals.service),
        plans: Arc::clone(&session.plans),
    }));
    // A resume settles the runs it named through recovery's finalize, registered before the start
    // serves anything, so no resume finds the port empty.
    session
        .resumed_runs
        .register(Arc::new(ResumedRunsFinalize::new(ResumedRunsFinalizeDeps {
            reads: Arc::clone(reads),
            run_engine: Arc::clone(&session.engine),
            delivery: session.queue.delivery(),
            providers: Arc::clone(registry),
            interventions: Arc::clone(&session.interventions),
        })) as Arc<dyn ResumedRunsIngress>)?;
    let stored = build_stored_data_methods(StoredDataMethodsStart {
        database,
        repo,
        data_folder,
        session_services: session,
        payloads: Arc::clone(&artifacts.payloads),
        shells: Arc::clone(shells),
        project_list_feed: Arc::clone(project_list_feed),
        providers: Arc::clone(registry),
        execution_postures: Arc::clone(&providers.execution_postures),
        machine_id: machine_id.clone(),
        configuration: Arc::clone(configuration),
        scheduler: Arc::clone(scheduler),
        backups: Arc::clone(backups),
        projection_rebuild: Arc::clone(&projection_rebuild),
        restart_settle: Arc::clone(&restart_settle),
        in_flight,
        accept_stop: Arc::clone(accept_stop),
    });
    let recovery = StartupRecovery::new(StartupRecoveryDeps {
        machine_id,
        reads: Arc::clone(reads),
        writer,
        appender: Arc::clone(&session.appender),
        projection_rebuild,
        damaged_history: Arc::clone(&stored.damaged_history),
        restart_settle,
        provider_sessions: Arc::clone(&session.provider_sessions),
        questions: Arc::clone(&session.questions),
        status: Arc::clone(&database.status),
        damage: Arc::clone(&database.damage),
        database_path: database.database_path.clone(),
        data_folder: data_folder.to_path_buf(),
        copier,
    });
    Ok(RecoveryServices { stored, recovery })
}
