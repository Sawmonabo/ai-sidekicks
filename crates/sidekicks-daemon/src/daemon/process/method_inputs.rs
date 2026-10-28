//! What the daemon's start builds over its store, its providers and its repository services for the
//! serving socket: the session directory's port, the session services, the terminals' table, the
//! project and clone services, the recovery services and the stored data's methods, then every
//! method table registered over them; it hands back the parts the start runs next and the stop
//! ends.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use futures::FutureExt as _;
use jiff::Timestamp;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::text::{BoundedText, TextError};
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::registry::{HandlerError, MethodRegistryBuilder, RegistrationError};
use sidekicks_platforms::{
    DaemonRunFolder, Spawner, TOOL_MEMORY_CAP_ENFORCEABLE, WallClock, available_memory,
    physical_memory, read_process_peak_bytes,
};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_queue::memory_gate::{
    INGEST_WORKER_BYTES, MemoryGate, MemoryGateFigures, QUICK_THREAD_BYTES,
};
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::projection_rebuild::ProjectionRebuildService;
use sidekicks_recovery::restart_settle::{RestartSettle, RestartSettleDeps};
use sidekicks_recovery::startup::{StartupRecovery, StartupRecoveryDeps};
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::groups::service::SessionGroupService;
use sidekicks_session::plan_holds::PlanHolds;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::epochs::{ExecutionEpochs, MAX_ASSOCIATIONS_PER_BINDING};
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_shell::orphan::guard::OrphanGuard;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::port_registration::{PortRegistration, PortRegistrationError};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_workspace::clone::service::{CloneService, CloneServiceDeps};
use sidekicks_workspace::folder::list::FolderListService;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::naming::worktrees_folder;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::managed::service::managed_workspaces_folder;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::service::{ProjectService, ProjectServiceDeps};

use crate::daemon::artifact_methods::ArtifactMethods;
use crate::daemon::backup::methods::BackupMethodsDeps;
use crate::daemon::backup::run::Backups;
use crate::daemon::config_methods::ConfigMethodsDeps;
use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::data_methods::DataMethodsDeps;
use crate::daemon::machine_settings::file::MachineSettingsFile;
use crate::daemon::machine_settings::methods::{
    FindBranchPatternRefusal, MachineSettingsMethodsDeps,
};
use crate::daemon::process::database::DatabaseFile;
use crate::daemon::process::method_tables::{MethodTableServices, register_method_tables};
use crate::daemon::process::projections::rebuild_projections;
use crate::daemon::process::provider_port::{ProviderPortStart, build_provider_port};
use crate::daemon::process::providers::Providers;
use crate::daemon::process::repo_services::RepoServices;
use crate::daemon::process::session_services::{
    SessionServiceStart, SessionServiceStartError, SessionServices, build_session_services,
};
use crate::daemon::process::shell_table::{
    ShellTableStart, ShellTableStartError, build_shell_table,
};
use crate::daemon::process::stored_data::{StoredDataMethodsStart, build_stored_data_methods};
use crate::daemon::process::supervision::ProcessStateTracker;
use crate::daemon::process_tree_usage::ProcessTreeUsageReader;
use crate::daemon::status_methods::StatusMethodsDeps;
use crate::data_acts::erase::{DataErase, DataEraseDeps, EraseStep};
use crate::data_acts::export::{DataExportDeps, DataExports};
use crate::ipc::handlers::approval::ApprovalMethodSources;
use crate::ipc::handlers::driver::DriverMethodSources;
use crate::ipc::handlers::run::control::RunControlServices;
use crate::ipc::handlers::run::queue::RunQueueMethods;
use crate::ipc::handlers::session::controls::SessionControlMethods;
use crate::ipc::handlers::session::search::SessionSearchMethods;
use crate::observability::diagnostic_buckets::recorders::provider_messages_folder;

/// What the method tables' services are built from: what the start opened, read and built before
/// them.
pub(crate) struct MethodInputsStart<'start> {
    /// The open database file.
    pub(crate) database: &'start DatabaseFile,
    /// The repository services; the chats' writes and the askpass broker are taken from them.
    pub(crate) repo: &'start mut RepoServices,
    /// The providers, whose ports the session directory registers on.
    pub(crate) providers: &'start Providers,
    /// The artifact store, whose payloads and publisher the sessions store through.
    pub(crate) artifacts: &'start ArtifactMethods,
    /// This machine.
    pub(crate) machine: LocalMachine,
    /// The daemon's one scheduler.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The session search index.
    pub(crate) search_index: Arc<LiveIndex>,
    /// The daemon's wall clock.
    pub(crate) clock: Arc<dyn WallClock>,
    /// The thread every child starts on.
    pub(crate) spawner: Spawner,
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// The login shell's environment captured at the start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// The approval rules, parsed and checked.
    pub(crate) authorizer: Arc<Authorizer>,
    /// The daemon's secrets.
    pub(crate) secret_items: Arc<SecretItems>,
    /// The machine's settings file.
    pub(crate) settings: Arc<MachineSettingsFile>,
    /// The daemon's configuration.
    pub(crate) configuration: Arc<ConfigurationStore>,
    /// The service's backups.
    pub(crate) backups: Arc<Backups>,
    /// The session list's feed, the one the repository services refresh.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The plan store's holds, the same the session list reads.
    pub(crate) plan_holds: Arc<dyn PlanHolds>,
    /// The record of every terminal child, opened by the start.
    pub(crate) orphan_guard: Arc<OrphanGuard>,
    /// The copy the recovery pass copies the store's files aside with.
    pub(crate) copier: Arc<DatabaseFileCopier>,
    /// The person's home folder.
    pub(crate) home_folder: &'start Path,
    /// The daemon's data folder.
    pub(crate) data_folder: &'start Path,
    /// The daemon's run folder.
    pub(crate) run_folder: &'start DaemonRunFolder,
    /// The daemon's own program.
    pub(crate) daemon_program: &'start Path,
    /// The daemon's own process as the system knows it.
    pub(crate) process_identity: ProcessIdentity,
    /// The service's own release version.
    pub(crate) version: ReleaseVersion,
    /// When the start began.
    pub(crate) started_at: Timestamp,
    /// Where the daemon is in its own life.
    pub(crate) process_state: Arc<ProcessStateTracker>,
    /// The serving socket's record of mutating calls, set once its gate chain is built.
    pub(crate) in_flight: Arc<OnceLock<Arc<InFlightMutations>>>,
    /// Starts the daemon's stop for the intent given.
    pub(crate) accept_stop: Arc<dyn Fn(DaemonStopIntent) + Send + Sync>,
    /// The erase's step that ends the daemon's work as the stop does.
    pub(crate) stop_work: EraseStep,
    /// The erase's step that closes everything that holds a file in the data folder.
    pub(crate) close_data_folder: EraseStep,
}

/// What the start runs next and the stop ends, of what it built for the method tables.
pub(crate) struct MethodInputs {
    /// The session services.
    pub(crate) session: SessionServices,
    /// The recovery pass, run once the socket is bound and before any follow of the log begins.
    pub(crate) recovery: StartupRecovery,
    /// The live projects list, closed at the stop.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
    /// The clone service, which owns the askpass broker and closes it at the stop; `None` when it
    /// could not start.
    pub(crate) clones: Option<Arc<CloneService>>,
}

/// Why the method tables' services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MethodInputsError {
    /// A driver port the session directory answers was registered already.
    #[error(transparent)]
    PortRegistration(#[from] PortRegistrationError),
    /// The session services could not be built.
    #[error(transparent)]
    SessionServices(#[from] SessionServiceStartError),
    /// The terminals' table could not be built.
    #[error(transparent)]
    ShellTable(#[from] ShellTableStartError),
    /// A method was registered twice.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
    /// This machine's stored id is no device id, so no run's hold can name it.
    #[error("this computer's id {} is not a device id", machine_id.as_str())]
    MachineDeviceId {
        /// The stored id.
        machine_id: MachineId,
    },
    /// The socket's path is too long for the status read to report.
    #[error("the socket path {} cannot be reported", path.display())]
    SocketPathText {
        /// The socket's path.
        path: PathBuf,
    },
    /// A folder's path cannot be reported on the wire.
    #[error("the folder path {} cannot be reported", path.display())]
    FolderPathText {
        /// The folder's path.
        path: PathBuf,
        /// Why its text was refused.
        #[source]
        source: TextError,
    },
}

/// Builds every service the method tables take from `start` and registers the tables on
/// `builder`, the stored data's flush reading `start.in_flight` once the start sets it. Fails as
/// [`MethodInputsError`] says; a clone service that cannot start leaves each clone verb refused
/// with why, and the start goes on. Runs inside the daemon's runtime.
pub(crate) async fn register_method_inputs(
    builder: &mut MethodRegistryBuilder,
    start: MethodInputsStart<'_>,
) -> Result<MethodInputs, MethodInputsError> {
    let MethodInputsStart {
        database,
        repo,
        providers,
        artifacts,
        machine,
        scheduler,
        search_index,
        clock,
        spawner,
        git,
        base_environment,
        shell_lines,
        authorizer,
        secret_items,
        settings,
        configuration,
        backups,
        list_feed,
        plan_holds,
        orphan_guard,
        copier,
        home_folder,
        data_folder,
        run_folder,
        daemon_program,
        process_identity,
        version,
        started_at,
        process_state,
        in_flight,
        accept_stop,
        stop_work,
        close_data_folder,
    } = start;
    let reads = Arc::clone(&database.pool);
    let writer = Arc::clone(&database.writer);
    let read_damaged_from_sequence = Arc::clone(&database.read_damaged_from_sequence);
    let registry = Arc::clone(&providers.registry);
    let settings_reader: Arc<dyn MachineSettingsReader> = Arc::clone(&settings) as _;
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        MAX_ASSOCIATIONS_PER_BINDING,
    )));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&reads),
        Arc::clone(&providers.runtime_bindings),
        Arc::clone(&epochs),
    ));
    let port = build_provider_port(ProviderPortStart {
        reads: Arc::clone(&reads),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
        binding_cursors: Arc::clone(&binding_cursors),
        git: git.clone(),
        settings: Arc::clone(&settings_reader),
        plan_holds: plan_holds.as_ref(),
        ports: &providers.ports,
    })?;
    let session = build_session_services(SessionServiceStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        event_log: Arc::clone(&database.event_log),
        followers: Arc::clone(&database.followers),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
        providers: Arc::clone(&registry),
        execution_postures: Arc::clone(&providers.execution_postures),
        binding_cursors,
        epochs,
        compose_opening: port.compose_opening,
        processes: Arc::clone(&providers.processes) as _,
        memory_gate: Arc::new(MemoryGate::new(
            MemoryGateFigures {
                physical_memory_bytes: physical_memory(),
                quick_thread_bytes: QUICK_THREAD_BYTES,
                ingest_worker_bytes: INGEST_WORKER_BYTES,
            },
            Arc::new(available_memory),
            Arc::new(read_process_peak_bytes),
        )),
        machine: machine.clone(),
        shell_lines,
        background_work: Arc::clone(&providers.background_work),
        authorizer,
        data_folder: data_folder.to_path_buf(),
        working_folders: Arc::clone(&repo.folder_watch),
        git: git.clone(),
        list_feed: Arc::clone(&list_feed),
        plan_holds,
        payloads: Arc::clone(&artifacts.payloads),
        publisher: Arc::clone(&artifacts.publisher),
        spool_folder: artifacts.spool_folder.clone(),
        workspaces_folder: managed_workspaces_folder(home_folder),
        workspace_writes: repo
            .workspace_writes
            .take()
            .expect("the start takes the chats' writes once"),
        clock,
        spawner,
        daemon_program: daemon_program.to_path_buf(),
    })?;
    let shells = Arc::new(
        build_shell_table(ShellTableStart {
            terminals: Arc::clone(&session.terminals),
            machine_device_id: device_id_of(&machine.machine_id)?,
            reads: Arc::clone(&reads),
            appender: Arc::clone(&session.appender),
            settings: Arc::clone(&settings),
            base_environment,
            reserved_names: Arc::clone(&providers.reserved_names),
            screen_reader_environment_names: registry
                .drivers()
                .flat_map(|(provider, _)| {
                    registry
                        .descriptor(provider)
                        .expect("a provider the registry lists has a descriptor")
                        .screen_reader_environment_names()
                })
                .copied()
                .collect(),
            run_folder: run_folder.folder_path.clone(),
            orphan_guard,
            daemon_program: daemon_program.to_path_buf(),
        })
        .await?,
    );
    let project_list_feed = Arc::new(ProjectListFeed::new(
        Arc::clone(&port.project_records),
        &database.followers,
    ));
    let driver_set_names = providers.reserved_names.names().to_vec();
    let projects = Arc::new(ProjectService::new(ProjectServiceDeps {
        writer: Arc::clone(&writer),
        records: Arc::clone(&port.project_records),
        mounts: Arc::clone(&repo.mounts),
        sessions: Arc::clone(&session.changes) as _,
        git: git.clone(),
        settings: Arc::clone(&settings_reader),
        driver_set_names: driver_set_names.clone(),
        worktrees_folder: worktrees_folder(home_folder),
        list_feed: Arc::clone(&project_list_feed),
    }));
    let clones = match repo
        .askpass
        .take()
        .expect("the start takes the askpass broker once")
    {
        Ok(askpass) => CloneService::start(CloneServiceDeps {
            projects: Arc::clone(&projects),
            records: Arc::clone(&port.project_records),
            reads: Arc::clone(&reads),
            askpass,
            settings: settings_reader,
            home_folder: home_folder.to_path_buf(),
            git: git.clone(),
            // No session waits on a clone in this build, so none is told one attached.
            clone_attached: Arc::new(PortRegistration::new("clone attached")),
        })
        .await
        .map_err(|error| {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the clone service did not start, so every clone is refused"
            );
            describe_error(&error)
        }),
        Err(unavailable) => Err(unavailable),
    };
    let projection_rebuild = Arc::new(ProjectionRebuildService::new(
        Arc::clone(&reads),
        Arc::clone(&writer),
        Arc::clone(&session.sessions),
        Arc::clone(&database.damage),
        rebuild_projections(),
    ));
    let restart_settle = Arc::new(RestartSettle::new(RestartSettleDeps {
        reads: Arc::clone(&reads),
        appender: Arc::clone(&session.appender),
        run_engine: Arc::clone(&session.engine),
        approvals: Arc::clone(&session.approvals.service),
        plans: Arc::clone(&session.plans),
    }));
    let stored = build_stored_data_methods(StoredDataMethodsStart {
        database,
        repo,
        session_services: &session,
        payloads: Arc::clone(&artifacts.payloads),
        shells: Arc::clone(&shells),
        project_list_feed: Arc::clone(&project_list_feed),
        providers: Arc::clone(&registry),
        machine_id: machine.machine_id.clone(),
        configuration: Arc::clone(&configuration),
        scheduler: Arc::clone(&scheduler),
        backups: Arc::clone(&backups),
        projection_rebuild: Arc::clone(&projection_rebuild),
        restart_settle: Arc::clone(&restart_settle),
        in_flight,
        accept_stop: Arc::clone(&accept_stop),
    });
    let recovery = StartupRecovery::new(StartupRecoveryDeps {
        machine_id: machine.machine_id,
        reads: Arc::clone(&reads),
        writer,
        appender: Arc::clone(&session.appender),
        projection_rebuild,
        damaged_history: Arc::clone(&stored.damaged_history),
        restart_settle,
        status: Arc::clone(&database.status),
        damage: Arc::clone(&database.damage),
        database_path: database.database_path.clone(),
        data_folder: data_folder.to_path_buf(),
        copier,
    });
    let driver_methods = Arc::new(DriverMethodSources {
        pool: Arc::clone(&reads),
        providers: Arc::clone(&registry),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
    });
    register_method_tables(
        builder,
        MethodTableServices {
            status: StatusMethodsDeps {
                process_identity,
                read_process_state: Arc::new(move || process_state.read()),
                recovery: Arc::clone(&database.status),
                version,
                transport_endpoint: BoundedText::new(
                    run_folder.socket_path.to_string_lossy().into_owned(),
                )
                .ok_or_else(|| MethodInputsError::SocketPathText {
                    path: run_folder.socket_path.clone(),
                })?,
                data_directory: filesystem_path(data_folder)?,
                started_at,
                usage_reader: Arc::new(ProcessTreeUsageReader::new()),
                secret_items: Arc::clone(&secret_items),
            },
            lifecycle: stored.lifecycle,
            retention: stored.retention,
            backups: BackupMethodsDeps { backups, scheduler },
            config: ConfigMethodsDeps {
                configuration,
                tool_memory_cap_enforceable: TOOL_MEMORY_CAP_ENFORCEABLE,
                provider_messages_path: filesystem_path(&provider_messages_folder(data_folder))?,
            },
            machine_settings: MachineSettingsMethodsDeps {
                settings_file: settings,
                driver_set_names,
                find_branch_pattern_refusal: machine_pattern_refusal(Arc::clone(&projects)),
            },
            data: DataMethodsDeps {
                exports: Arc::new(DataExports::new(DataExportDeps {
                    reads: Arc::clone(&reads),
                    read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
                    payloads: Arc::clone(&artifacts.payloads),
                })),
                erase: Arc::new(DataErase::new(DataEraseDeps {
                    data_folder: data_folder.to_path_buf(),
                    secret_items,
                    providers: Arc::clone(&registry),
                    stop_work,
                    close_data_folder,
                    end_process: Arc::new(move || accept_stop(DaemonStopIntent::Stop)),
                })),
            },
            data_folder: data_folder.to_path_buf(),
            driver_methods: Arc::clone(&driver_methods),
            approval_methods: Arc::new(ApprovalMethodSources {
                pool: Arc::clone(&reads),
                permission_asks: Arc::clone(&session.approvals.asks),
                rules: Arc::clone(&session.approvals.rules),
                reviewer_denials: Arc::clone(&session.approvals.denials),
            }),
            run_control: RunControlServices {
                interventions: Arc::clone(&session.interventions),
                pauses: Arc::clone(&session.pauses),
                choices: Arc::clone(&session.choices),
                continued: Arc::new(session.queue.delivery()),
            },
            run_queue: RunQueueMethods {
                queue: Arc::clone(&session.queue),
                log: Arc::clone(&database.event_log),
                pool: Arc::clone(&reads),
                signals: Arc::clone(&session.signals),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
            },
            providers: registry,
            restart_targets: port.restart_targets,
            restart_state_pool: reads,
            session_transition_lock: Arc::clone(session.changes.transition_lock()),
            event_log: Arc::clone(&database.event_log),
            run_safety_holds: Arc::clone(&session.run_safety_holds),
            sessions: Arc::clone(&session.sessions),
            drafts: Arc::clone(&session.drafts),
            tags: Arc::clone(&session.tags),
            session_groups: Arc::new(SessionGroupService::new(
                Arc::clone(&database.writer),
                list_feed,
            )),
            links: Arc::clone(&session.links),
            related_ranking: Arc::clone(&session.related_ranking),
            list_feed: Arc::clone(&session.list_feed),
            questions: Arc::clone(&session.questions),
            damaged_history: stored.damaged_history,
            highlighter: Arc::clone(&session.highlighter),
            shells,
            session_changes: Arc::clone(&session.changes),
            review_notes: Arc::clone(&repo.review_notes),
            session_search: SessionSearchMethods {
                index: search_index,
                files: Arc::clone(&session.file_search),
                read_damaged_from_sequence,
            },
            session_controls: SessionControlMethods {
                sources: driver_methods,
                provider_sessions: Arc::clone(&session.provider_sessions),
                run_queue: Arc::clone(&session.queue),
            },
            branches: Arc::clone(&repo.branches),
            working_folders: Arc::clone(&repo.folder_watch),
            projects,
            project_list_feed: Arc::clone(&project_list_feed),
            clones: clones.clone(),
            machine_folders: Arc::new(FolderListService::new(home_folder.to_path_buf(), git)),
        },
    )?;
    Ok(MethodInputs {
        session,
        recovery,
        project_list_feed,
        clones: clones.ok(),
    })
}

// This machine's own device id, which a run's hold on a shell names: a machine's id is the device
// of every local connection to its service.
fn device_id_of(machine_id: &MachineId) -> Result<DeviceId, MethodInputsError> {
    DeviceId::new(machine_id.as_str().to_owned()).ok_or_else(|| {
        MethodInputsError::MachineDeviceId {
            machine_id: machine_id.clone(),
        }
    })
}

// `path` as the wire carries a folder.
fn filesystem_path(path: &Path) -> Result<FilesystemPath, MethodInputsError> {
    FilesystemPath::new(path.to_string_lossy().into_owned()).map_err(|source| {
        MethodInputsError::FolderPathText {
            path: path.to_path_buf(),
            source,
        }
    })
}

// The machine settings' check of a new `Branch names` pattern against every project that keeps
// none of its own.
fn machine_pattern_refusal(projects: Arc<ProjectService>) -> FindBranchPatternRefusal {
    Arc::new(move |pattern| {
        let projects = Arc::clone(&projects);
        async move {
            projects
                .find_machine_branch_pattern_refusal(&pattern)
                .await
                .map_err(HandlerError::from)
        }
        .boxed()
    })
}
