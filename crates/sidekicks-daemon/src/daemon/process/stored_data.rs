//! The method inputs that act on the daemon's stored data as a whole: the one session purge that
//! `Delete old data` and a damaged session's `Delete session` share, the repack a purge schedules,
//! damaged history, and the flush a quit sends, which reaches the serving socket's record of
//! mutating calls.

use std::sync::{Arc, OnceLock};

use sidekicks_artifact::payload_store::PayloadStore;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_platforms::volume_free_bytes;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_recovery::damaged_history::{
    DamagedHistory, DamagedHistoryDeps, DamagedSessionPurge,
};
use sidekicks_recovery::projection_rebuild::ProjectionRebuildService;
use sidekicks_recovery::restart_settle::RestartSettle;
use sidekicks_session::conversation_purge::ConversationPurge;
use sidekicks_shell::table::ShellTable;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::writer::repack::RepackJobDeps;
use sidekicks_workspace::project::list_feed::ProjectListFeed;

use crate::daemon::backup::run::{BACKUP_BUDGET, Backups};
use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::lifecycle_methods::{LifecycleMethodsDeps, flush_writes};
use crate::daemon::process::database::DatabaseFile;
use crate::daemon::process::repo_services::RepoServices;
use crate::daemon::process::session_services::SessionServices;
use crate::daemon::retention_methods::RetentionMethodsDeps;
use crate::data_acts::purge::{SessionPurge, SessionPurgeDeps};

/// What the stored data's methods are built from: the services the start has built, and the two
/// recovery services the start's recovery pass shares with damaged history.
pub(crate) struct StoredDataMethodsStart<'start> {
    /// The open database file.
    pub(crate) database: &'start DatabaseFile,
    /// The repository services, whose turn snapshots and managed workspaces a purge deletes.
    pub(crate) repo: &'start RepoServices,
    /// The session services.
    pub(crate) session_services: &'start SessionServices,
    /// The artifact store's payloads, which a purge unlinks once no manifest names them.
    pub(crate) payloads: Arc<PayloadStore>,
    /// The terminals' shells, which a purge ends.
    pub(crate) shells: Arc<ShellTable>,
    /// The project list, which a purge tells of each session it marks and removes.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
    /// Every driver, through which a purge deletes the provider's copy of each conversation.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// This machine, named in each purge's receipt.
    pub(crate) machine_id: MachineId,
    /// The configuration store holding the retention bounds.
    pub(crate) configuration: Arc<ConfigurationStore>,
    /// The daemon's one scheduler, which runs the repack a purge schedules.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The service's backups, one of which follows a purge that removed a session.
    pub(crate) backups: Arc<Backups>,
    /// The rebuilds of a session's projections, shared with the start's recovery pass.
    pub(crate) projection_rebuild: Arc<ProjectionRebuildService>,
    /// What a restart left in a session, settled; shared with the start's recovery pass.
    pub(crate) restart_settle: Arc<RestartSettle>,
    /// The serving socket's record of mutating calls, set once its gate chain is built.
    pub(crate) in_flight: Arc<OnceLock<Arc<InFlightMutations>>>,
    /// Starts the daemon's stop for the intent given.
    pub(crate) accept_stop: Arc<dyn Fn(DaemonStopIntent) + Send + Sync>,
}

/// The inputs of the retention, lifecycle and damaged-history methods.
pub(crate) struct StoredDataMethods {
    /// The retention methods' inputs.
    pub(crate) retention: RetentionMethodsDeps,
    /// The lifecycle verbs' inputs.
    pub(crate) lifecycle: LifecycleMethodsDeps,
    /// The sessions whose history is damaged, and their two recovery actions.
    pub(crate) damaged_history: Arc<DamagedHistory>,
}

/// Builds the one session purge over `start`'s services, then the retention methods' and damaged
/// history's inputs over it and the lifecycle verbs' flush over the database's writer.
pub(crate) fn build_stored_data_methods(start: StoredDataMethodsStart<'_>) -> StoredDataMethods {
    let StoredDataMethodsStart {
        database,
        repo,
        session_services,
        payloads,
        shells,
        project_list_feed,
        providers,
        machine_id,
        configuration,
        scheduler,
        backups,
        projection_rebuild,
        restart_settle,
        in_flight,
        accept_stop,
    } = start;
    let purge = Arc::new(SessionPurge::new(SessionPurgeDeps {
        writer: Arc::clone(&database.writer),
        reads: Arc::clone(&database.pool),
        event_log: Arc::clone(&database.event_log),
        machine_id,
        transition_lock: Arc::clone(session_services.changes.transition_lock()),
        shells,
        conversations: Arc::new(ConversationPurge::new(
            Arc::clone(&database.pool),
            providers,
        )),
        managed_workspaces: Arc::clone(&repo.workspaces),
        snapshots: Arc::clone(&repo.snapshots),
        project_rules: Arc::clone(&session_services.approvals.rules),
        list_feed: Arc::clone(&session_services.list_feed),
        project_list_feed,
        ranking: Arc::clone(&session_services.related_ranking),
        payloads,
        truncation: Arc::clone(&database.truncation),
        recovery: Arc::clone(&database.status),
        sessions: Arc::clone(&session_services.sessions),
        context_readings: Arc::clone(&session_services.context_readings),
        turn_readings: Arc::clone(&session_services.turn_readings),
    }));
    let damaged_history = Arc::new(DamagedHistory::new(DamagedHistoryDeps {
        reads: Arc::clone(&database.pool),
        session_events: Arc::clone(&session_services.sessions),
        appender: Arc::clone(&session_services.appender),
        writer: Arc::clone(&database.writer),
        projection_rebuild,
        restart_settle,
        purge: Arc::clone(&purge) as Arc<dyn DamagedSessionPurge>,
        status: Arc::clone(&database.status),
    }));
    StoredDataMethods {
        retention: RetentionMethodsDeps {
            configuration,
            reads: Arc::clone(&database.pool),
            purge,
            scheduler,
            repack: Arc::new(RepackJobDeps {
                writer: Arc::clone(&database.writer),
                truncation: Arc::clone(&database.truncation),
                database_path: database.database_path.clone(),
                read_volume_free_bytes: volume_free_bytes,
                live_runs: database.live_runs.clone(),
                budget: BACKUP_BUDGET,
            }),
            backups,
        },
        lifecycle: LifecycleMethodsDeps {
            flush: flush_writes(in_flight, Arc::clone(&database.writer)),
            accept_stop,
        },
        damaged_history,
    }
}
