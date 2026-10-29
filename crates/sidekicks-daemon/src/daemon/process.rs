//! The running daemon: its start, in the order each service needs the ones before it, and its
//! stop, in the reverse order, carrying why it stops. A start that fails releases what it took,
//! in the stop's order, and names the step that failed.

mod approvals;
mod crash_monitor;
pub(crate) mod damage_gate;
pub(crate) mod database;
pub(crate) mod jobs;
mod method_inputs;
pub(crate) mod method_tables;
mod projections;
mod provider_port;
pub(crate) mod providers;
mod repo_services;
mod session_services;
mod shell_table;
pub(crate) mod start_error;
pub(crate) mod start_options;
pub(crate) mod stop;
mod stored_data;
pub(crate) mod supervision;
#[cfg(test)]
mod tests;
pub(crate) mod workspace_services;
mod worktree_sources;

use std::error::Error;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::FutureExt as _;
use jiff::Timestamp;
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_contracts::daemon::lifecycle::{DAEMON_READY_LINE, DAEMON_STOP_DRAIN_BOUND_MS};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::MethodRegistryBuilder;
use sidekicks_ipc::stream::subscriptions::Subscriptions;
use sidekicks_platforms::{
    Spawner, WakeWatch, WallClock, WallClockTimer, askpass_socket_path, check_socket_path,
    read_command_argument_limit,
};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::command::channel::remove_channel_folders;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::database_file::sqlite_shell::SqliteShell;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::search::index::live::{LiveIndex, LiveIndexOptions};
use sidekicks_shell::orphan::guard::{OrphanGuard, open_orphan_guard};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::KEYCHAIN_CALL_TIMEOUT;
use sidekicks_store::data_folder::lock::DataFolderLock;
use sidekicks_store::data_folder::{data_folder, program_link_folder};
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, SEARCH_INDEX_FOLDER_NAME,
};
use sidekicks_store::machine::identity_key::MachineIdentity;
use sidekicks_store::machine::local::read_or_mint_local_machine;
use sidekicks_workspace::clone::service::CloneService;
use sidekicks_workspace::git::process::{GitLimits, GitRunner, find_git_executable};
use sidekicks_workspace::git::worktree::creation::WorktreeCreator;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupRunner;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::bootstrap::{SecureDefaults, SecureDefaultsConfig};
use crate::daemon::artifact_methods::{ArtifactMethodsDeps, register_artifact_methods};
use crate::daemon::backup::roots::mirror_roots_reader;
use crate::daemon::backup::run::{
    BackupDeps, Backups, backup_folder, backup_manifest_facts, default_backup_folder,
};
use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::crash::monitor::{crash_monitor_socket_path, remove_dead_monitor_sockets};
use crate::daemon::login_shell_environment::capture_provider_base_environment;
use crate::daemon::machine_settings::file::{MachineSettingsFile, machine_settings_file_path};
use crate::daemon::process::crash_monitor::CrashMonitor;
use crate::daemon::process::damage_gate::DispatchDamageWatch;
use crate::daemon::process::database::{DatabaseFile, DatabaseFileStart, open_database_file};
use crate::daemon::process::jobs::{IdleMemoryCollect, JobDeps, schedule_jobs};
use crate::daemon::process::method_inputs::{
    MethodInputsStart, device_id_of, register_method_inputs,
};
use crate::daemon::process::method_tables::gate_chain;
use crate::daemon::process::providers::{
    ProviderStart, Providers, ProvidersRegistration, build_providers, hydrate_capabilities,
    register_providers, sweep_left_staged_worktrees,
};
use crate::daemon::process::repo_services::{
    RepoAttachments, RepoServiceStart, RepoServices, build_repo_services, make_worktrees_folder,
    managed_writes_watermark_path, read_managed_writes_watermark, start_repo_attachments,
};
use crate::daemon::process::session_services::{
    SessionAttachments, SessionServices, start_session_attachments,
};
use crate::daemon::process::start_error::{DaemonStartError, DaemonStartFailure};
use crate::daemon::process::start_options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::process::stop::{DaemonStopFailure, close_data_folder, stop_work};
use crate::daemon::process::supervision::{ProcessStateTracker, ServingSocketHooks};
use crate::daemon::process::workspace_services::{WorkspaceWork, settle_interrupted_creations};
use crate::daemon::run_folder::{bind_socket, mint_session_token, prepare_run_folder};
use crate::daemon::service_status::remove_service_status;
use crate::daemon::start_stopped_error::DaemonStartStoppedError;
use crate::data_acts::erase::EraseStep;
use crate::ipc::local_gateway::{GatewayServices, LocalGateway};
use crate::observability::diagnostic_buckets::expiry::{
    DiagnosticExpiryDeps, live_diagnostic_files,
};

/// The longest the stop's drain runs, the work ending and the data folder closing together.
pub(crate) const DAEMON_STOP_DRAIN_BOUND: Duration =
    Duration::from_millis(DAEMON_STOP_DRAIN_BOUND_MS);

/// A step of the erase the process runs on the task that owns it, answering once the step ran.
enum DaemonCommand {
    /// Ends the daemon's work as the stop does.
    StopWork(oneshot::Sender<()>),
    /// Closes everything that holds a file in the data folder.
    CloseDataFolder(oneshot::Sender<()>),
}

/// The running daemon: every service it started, held in the order its stop ends them, each part
/// a step closes taken as it closes, so a later stop skips it.
pub(crate) struct DaemonProcess {
    /// When the start began, which the status read reports.
    pub(crate) started_at: Timestamp,
    /// The system's stop request.
    system_stop: CancellationToken,
    /// The first stop asked for over the socket, with why.
    stop_asked: watch::Sender<Option<DaemonStopIntent>>,
    /// The erase's steps, sent to the task that owns the process.
    commands: mpsc::Receiver<DaemonCommand>,
    /// Where the erase's steps are sent; held here, so the receiver never ends while the process
    /// lives.
    command_sender: mpsc::Sender<DaemonCommand>,
    /// Canceled at the stop, so the work under way ends.
    pub(crate) work_stop: CancellationToken,
    /// Where the daemon is in its own life.
    pub(crate) process_state: Arc<ProcessStateTracker>,
    /// The thread every child starts on, kept for the daemon's life: on Linux a child armed to end
    /// with the daemon ends once the thread that started it has.
    spawner: Spawner,
    /// The daemon's git, whose failed calls' trees the stop waits for.
    pub(crate) git: Option<GitRunner>,
    /// The serving socket, while it serves.
    pub(crate) gateway: Option<LocalGateway>,
    /// The record of every terminal child, closed once the terminals have drained.
    pub(crate) orphan_guard: Option<Arc<OrphanGuard>>,
    /// The crash monitor, ended before the data folder's lock goes.
    pub(crate) crash_monitor: Option<CrashMonitor>,
    /// The hold on the data folder, let go last.
    pub(crate) data_folder_lock: Option<DataFolderLock>,
    /// The database file, closed first as the data folder closes.
    pub(crate) database: Option<DatabaseFile>,
    /// This machine's two keys, whose background read the stop joins within the drain bound.
    pub(crate) machine_identity: Option<Arc<MachineIdentity>>,
    /// When the stop began, from which what is left of the drain bound is counted.
    pub(crate) stop_started: Option<Instant>,
    /// Whether a step of the stop failed, so no clean stop is recorded.
    pub(crate) has_stop_failed: bool,
    /// Hands freed memory back once the work goes quiet; ends with the work.
    idle_memory: Option<Arc<IdleMemoryCollect>>,
    /// Runs the background jobs, stopped as the work ends.
    pub(crate) scheduler: Option<Arc<Scheduler>>,
    /// The session search index, closed as the work ends.
    pub(crate) search_index: Option<Arc<LiveIndex>>,
    /// The gate that records every mutating call while it runs, which the stop waits on.
    pub(crate) in_flight: Option<Arc<InFlightMutations>>,
    /// The providers, whose drivers the stop shuts down last.
    pub(crate) providers: Option<Providers>,
    /// The providers' first reads and row values, ended by the stop before the drivers.
    pub(crate) providers_registration: Option<ProvidersRegistration>,
    /// The repository services, whose watch, fetches and askpass broker the stop ends.
    pub(crate) repo: Option<RepoServices>,
    /// The repository services' background work, ended by the stop before the scheduler.
    pub(crate) repo_attachments: Option<RepoAttachments>,
    /// The session services: the stop ends the queue, the renames' name pushes, the highlighter
    /// and the terminals, and lets the rest go before the database file closes.
    pub(crate) session: Option<SessionServices>,
    /// The session services' follows of the log, ended by the stop with the chats' write watch.
    pub(crate) session_attachments: Option<SessionAttachments>,
    /// The attention service's decision task, which ends with the work's stop and is waited out.
    pub(crate) attention: Option<JoinHandle<()>>,
    /// The clone service, which owns the askpass broker; the stop closes it.
    pub(crate) clones: Option<Arc<CloneService>>,
    /// The live projects list, closed by the stop.
    pub(crate) project_list_feed: Option<Arc<ProjectListFeed>>,
    /// The setup card of every worktree made, whose running commands the stop ends.
    pub(crate) worktree_setup: Option<Arc<WorktreeSetupRunner>>,
    /// Makes worktrees and answers the new-worktree form's suggestion.
    pub(crate) worktree_creator: Option<Arc<WorktreeCreator>>,
    /// The workspace services' work: the stop ends the cleanup's requests and waits for the
    /// start's tasks, and lets the kept worktrees' reads settle last.
    pub(crate) workspace_work: Option<WorkspaceWork>,
}

// What a failed start's release is called in its error.
const START_OPERATION: &str = "the daemon's start";

impl DaemonProcess {
    /// Starts the daemon with `options` and answers it once it is ready. A failed step releases
    /// what the start took, in the stop's order, and fails with the step's error beside every
    /// failure of that release; a stop asked for before the daemon is ready fails it with
    /// [`DaemonStartError::Stopped`].
    pub(crate) async fn start(options: DaemonStartOptions) -> Result<Self, DaemonStartFailure> {
        let started_at = Timestamp::now();
        let spawner = match Spawner::new(tokio::runtime::Handle::current()) {
            Ok(spawner) => spawner,
            Err(error) => {
                return Err(DaemonStartFailure {
                    failures: Box::new(CleanupFailures::new(
                        DaemonStartError::Spawner(error),
                        Vec::new(),
                        START_OPERATION,
                    )),
                    release_started: Instant::now(),
                });
            }
        };
        let (command_sender, commands) = mpsc::channel(1);
        let mut process = Self {
            started_at,
            work_stop: options.stop.child_token(),
            system_stop: options.stop.clone(),
            stop_asked: watch::Sender::new(None),
            commands,
            command_sender,
            process_state: ProcessStateTracker::new(),
            spawner,
            git: None,
            gateway: None,
            orphan_guard: None,
            crash_monitor: None,
            data_folder_lock: None,
            database: None,
            machine_identity: None,
            stop_started: None,
            has_stop_failed: false,
            idle_memory: None,
            scheduler: None,
            search_index: None,
            in_flight: None,
            providers: None,
            providers_registration: None,
            repo: None,
            repo_attachments: None,
            session: None,
            session_attachments: None,
            attention: None,
            clones: None,
            project_list_feed: None,
            worktree_setup: None,
            worktree_creator: None,
            workspace_work: None,
        };
        let started = process.run_start(options).await;
        match started {
            Ok(()) => Ok(process),
            Err(error) => Err(process.release(error).await),
        }
    }

    // The start's steps, each part kept in the process as it is taken, so a failure releases it.
    async fn run_start(&mut self, options: DaemonStartOptions) -> Result<(), DaemonStartError> {
        let DaemonStartOptions {
            home_folder,
            data_folder_lock,
            run_folder,
            daemon_program,
            process_identity,
            version,
            caller_process_reader,
            stop: _,
            base_environment,
            credential_store,
            service_log_files,
            provider_registrations,
        } = options;
        self.data_folder_lock = Some(data_folder_lock);
        let (home_folder, run_folder, daemon_program) =
            (home_folder.as_path(), &run_folder, daemon_program.as_path());
        let monitor_socket_path =
            crash_monitor_socket_path(&run_folder.folder_path, std::process::id());
        let askpass_socket_path = askpass_socket_path(&run_folder.folder_path);
        for path in [
            &run_folder.socket_path,
            &monitor_socket_path,
            &askpass_socket_path,
        ] {
            check_socket_path(path).map_err(|source| DaemonStartError::SocketPathRefused {
                path: path.clone(),
                source,
            })?;
        }
        let data_folder = data_folder(home_folder);
        prepare_run_folder(run_folder).await?;
        remove_dead_monitor_sockets(&run_folder.folder_path).await;
        let session_token = mint_session_token().map_err(DaemonStartError::SessionToken)?;
        self.crash_monitor
            .insert(CrashMonitor::spawn(&self.spawner, daemon_program, monitor_socket_path).await?)
            .connect()
            .await?;
        let shell_lines = Arc::new(ShellLineReadingBound::new(
            read_command_argument_limit().map_err(DaemonStartError::CommandArgumentLimit)?,
        ));
        let capture = async {
            match base_environment {
                ProviderBaseEnvironment::Capture => {
                    capture_provider_base_environment(&self.spawner, home_folder, &self.work_stop)
                        .await
                        .map(Arc::from)
                }
                ProviderBaseEnvironment::Given(pairs) => Ok(pairs),
            }
        };
        let (base_environment, orphan_guard) =
            tokio::join!(capture, open_orphan_guard(&data_folder));
        let orphan_guard = Arc::new(orphan_guard.map_err(DaemonStartError::OrphanGuard)?);
        self.orphan_guard = Some(Arc::clone(&orphan_guard));
        let base_environment = base_environment.map_err(DaemonStartError::BaseEnvironment)?;
        let settings = Arc::new(MachineSettingsFile::new(machine_settings_file_path(
            home_folder,
        )));
        // The repair reads the newest backup, which a failed settings read still finds in the
        // default folder.
        let backup_folder = match backup_folder(&settings, home_folder).await {
            Ok(folder) => folder,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the backup settings could not be read, so the repair reads the default \
                     backups folder"
                );
                default_backup_folder(home_folder)
            }
        };
        let shell = SqliteShell::new(daemon_program.to_path_buf(), self.spawner.clone());
        let copier = Arc::new(DatabaseFileCopier::new(
            daemon_program.to_path_buf(),
            self.spawner.clone(),
        ));
        let secure_defaults = SecureDefaults::load(SecureDefaultsConfig {
            local_ipc_path: run_folder.socket_path.clone(),
        })?;
        let index_folder = data_folder.join(SEARCH_INDEX_FOLDER_NAME);
        // Taken before the database's hold on the process, which lasts to the method tables.
        let accept_stop = self.accept_stop();
        let stop_work_step = self.stop_work_step();
        let close_data_folder_step = self.close_data_folder_step();
        let database = self.database.insert(
            open_database_file(DatabaseFileStart {
                database_path: data_folder.join(DAEMON_DATABASE_FILE_NAME),
                data_folder: data_folder.clone(),
                index_folder_path: index_folder.clone(),
                shell: &shell,
                copier: &copier,
                now: Timestamp::now(),
                backup_folder,
                run_folder,
                secure_defaults: &secure_defaults,
                caller_process_reader: Arc::clone(&caller_process_reader),
                process_state: Arc::clone(&self.process_state),
                stop: &self.work_stop,
            })
            .await?,
        );
        let database_path = database.database_path.clone();
        let writer = Arc::clone(&database.writer);
        let reads = Arc::clone(&database.pool);
        let event_log = Arc::clone(&database.event_log);
        let truncation = Arc::clone(&database.truncation);
        let followers = Arc::clone(&database.followers);
        let status = Arc::clone(&database.status);
        let damage = DispatchDamageWatch(Arc::clone(&database.damage));
        let live_runs = database.live_runs.clone();
        let attention_changes = database.attention_changes.clone();
        let idle_memory = Arc::clone(self.idle_memory.insert(Arc::new(IdleMemoryCollect::start(
            live_runs.clone(),
            self.work_stop.clone(),
        ))));
        let machine = read_or_mint_local_machine(&reads, &writer, &self.spawner).await?;
        let machine_device_id = device_id_of(&machine.machine_id)?;
        let wall_clock: Arc<dyn WallClock> =
            Arc::new(WallClockTimer::new().map_err(DaemonStartError::WallClock)?);
        // With no wake heard, a wall-clock job still runs at its instant, only not at once after
        // a sleep that passed it.
        let wake_watch = match WakeWatch::start().await {
            Ok(wake_watch) => Some(wake_watch),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the computer's wakes cannot be heard, so the scheduler runs without them"
                );
                None
            }
        };
        let scheduler = Arc::clone(self.scheduler.insert(Arc::new(Scheduler::start(
            Arc::clone(&wall_clock),
            wake_watch,
            live_runs,
        ))));
        let search_index = Arc::clone(self.search_index.insert(Arc::new(LiveIndex::start(
            LiveIndexOptions {
                database_path,
                index_folder,
                program: daemon_program.to_path_buf(),
                spawner: self.spawner.clone(),
                reads: Arc::clone(&reads),
                writer: Arc::clone(&writer),
                scheduler: Arc::clone(&scheduler),
            },
        ))));
        self.check_stop("capturing the providers' base environment")?;
        let git = GitRunner::new(
            self.spawner.clone(),
            find_git_executable(&base_environment),
            Arc::clone(&base_environment),
            GitLimits::DAEMON,
        );
        self.git = Some(git.clone());
        let worktrees_folder = make_worktrees_folder(home_folder)
            .await
            .map_err(DaemonStartError::WorktreesFolder)?;
        let missed_since =
            read_managed_writes_watermark(&managed_writes_watermark_path(home_folder)).await;
        let list_feed = Arc::new(SessionListFeed::new(
            Arc::clone(&reads),
            &followers,
            Arc::clone(&scheduler),
            &StoredPlanHolds,
        ));
        self.repo = Some(build_repo_services(RepoServiceStart {
            home_folder: home_folder.to_path_buf(),
            run_folder: run_folder.folder_path.clone(),
            program_link_folder: program_link_folder(&data_folder),
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&writer),
            event_log: Arc::clone(&event_log),
            machine_id: machine.machine_id.clone(),
            scheduler: Arc::clone(&scheduler),
            list_feed: Arc::clone(&list_feed),
            stop: self.work_stop.clone(),
            worktrees_folder: worktrees_folder.clone(),
            missed_since,
        })?);
        let authorizer = Arc::new(Authorizer::load_built_in()?);
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder: data_folder.clone(),
            // The service starts only as the per-user agent or the app's child.
            runs_while_logged_out: false,
            access: credential_store,
            call_timeout: KEYCHAIN_CALL_TIMEOUT,
        })
        .map_err(DaemonStartError::SecretItems)?;
        // Its first read runs on its own task, so the start never waits on the keychain.
        let machine_identity = Arc::clone(self.machine_identity.insert(MachineIdentity::new(
            &machine,
            &secret_items,
            Arc::clone(&reads),
            Arc::clone(&writer),
        )));
        let configuration = Arc::new(ConfigurationStore::open(Arc::clone(&writer), &reads).await?);
        let mut builder = MethodRegistryBuilder::new();
        let artifacts = register_artifact_methods(
            &mut builder,
            ArtifactMethodsDeps {
                event_log: Arc::clone(&event_log),
                reads: Arc::clone(&reads),
                data_folder: data_folder.clone(),
                clock: Arc::clone(&wall_clock),
            },
        )?;
        let providers = build_providers(
            provider_registrations,
            ProviderStart {
                spawner: self.spawner.clone(),
                data_folder: data_folder.clone(),
                home_folder: home_folder.to_path_buf(),
                worktrees_folder,
                session_token_path: run_folder.token_path.clone(),
                reads: Arc::clone(&reads),
                writer: Arc::clone(&writer),
                attachments: Arc::clone(&artifacts.attachments) as _,
                git: git.clone(),
                base_environment: Arc::clone(&base_environment),
                shell_lines: Arc::clone(&shell_lines),
                caller_processes: Arc::clone(&caller_process_reader),
                build_record_readers: Arc::new(attention_changes),
            },
        );
        let backups = Backups::new(BackupDeps {
            writer: Arc::clone(&writer),
            event_log,
            reads: Arc::clone(&reads),
            truncation,
            settings: Arc::clone(&settings),
            home_folder: home_folder.to_path_buf(),
            read_mirror_roots: mirror_roots_reader(
                home_folder.to_path_buf(),
                Arc::clone(&reads),
                Arc::clone(&providers.registry),
            ),
            manifest_facts: backup_manifest_facts(),
        });
        hydrate_capabilities(&providers).await;
        sweep_left_staged_worktrees(&providers).await;
        // A channel a previous run left served processes that ended with it; a new one takes new
        // keys, so a folder left behind is only logged.
        if let Err(error) = remove_channel_folders(&data_folder).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a command channel folder a previous run left was not removed"
            );
        }
        let drivers = Arc::clone(&providers.registry);
        let in_flight: Arc<OnceLock<Arc<InFlightMutations>>> = Arc::default();
        let inputs = register_method_inputs(
            &mut builder,
            MethodInputsStart {
                database: self
                    .database
                    .as_ref()
                    .expect("the database file opens before the method tables"),
                repo: self
                    .repo
                    .as_mut()
                    .expect("the repository services are built before the method tables"),
                providers: &providers,
                artifacts: &artifacts,
                machine,
                machine_device_id,
                scheduler: Arc::clone(&scheduler),
                search_index: Arc::clone(&search_index),
                clock: wall_clock,
                spawner: self.spawner.clone(),
                git,
                base_environment,
                shell_lines,
                authorizer,
                secret_items,
                machine_identity,
                settings: Arc::clone(&settings),
                configuration: Arc::clone(&configuration),
                backups: Arc::clone(&backups),
                list_feed,
                plan_holds: Arc::new(StoredPlanHolds),
                orphan_guard,
                copier,
                home_folder,
                data_folder: &data_folder,
                run_folder,
                daemon_program,
                process_identity,
                version,
                started_at: self.started_at,
                process_state: Arc::clone(&self.process_state),
                in_flight: Arc::clone(&in_flight),
                accept_stop,
                stop_work: stop_work_step,
                close_data_folder: close_data_folder_step,
            },
        )
        .await?;
        let recovery = inputs.recovery;
        let attention = inputs.attention;
        self.project_list_feed = Some(inputs.project_list_feed);
        self.clones = inputs.clones;
        self.worktree_setup = Some(inputs.worktree_setup);
        self.workspace_work = Some(inputs.workspace_work);
        // Before the socket serves, so no creation is under way.
        settle_interrupted_creations(self.worktree_creator.insert(inputs.worktree_creator)).await;
        let session = self.session.insert(inputs.session);
        let queue = Arc::clone(&session.queue);
        let caller_check = CallerCheck::new(
            Arc::clone(&caller_process_reader),
            Arc::new(Default::default),
            Arc::clone(&providers.provider_services),
        );
        let negotiator =
            ProtocolNegotiator::new(session_token.clone(), caller_check.admission_check());
        let subscriptions = Subscriptions::new(Arc::new(damage.clone()));
        negotiator.register_handshake(&mut builder)?;
        subscriptions.register_cancel(&mut builder)?;
        let registry = Arc::new(builder.freeze());
        let gates = gate_chain(&negotiator, &registry, status, damage, &idle_memory);
        assert!(
            in_flight.set(Arc::clone(&gates.in_flight)).is_ok(),
            "the gate chain is built once"
        );
        self.in_flight = Some(gates.in_flight);
        let services = GatewayServices {
            device_id: Some(inputs.machine_device_id),
            dispatch: gates.dispatch,
            registry,
            negotiator,
            subscriptions,
            presence: inputs.presence,
            hooks: Arc::new(ServingSocketHooks {
                process_state: Arc::clone(&self.process_state),
            }),
        };
        self.gateway = Some(
            bind_socket(
                || LocalGateway::start(services, caller_process_reader, &secure_defaults),
                run_folder,
                session_token,
            )
            .await?,
        );
        let status_run_folder = run_folder.clone();
        tokio::task::spawn_blocking(move || remove_service_status(&status_run_folder))
            .await
            .map_err(|ended| DaemonStartError::ServiceStatus(std::io::Error::other(ended)))?
            .map_err(DaemonStartError::ServiceStatus)?;
        self.check_stop("binding the socket")?;
        // A stop settles the wait, so the registration never waits on an index that cannot open.
        let index_opened = {
            let stop = self.work_stop.clone();
            async move {
                tokio::select! {
                    () = search_index.when_open_settled() => {}
                    () = stop.cancelled() => {}
                }
            }
        };
        let registration = self.providers_registration.insert(register_providers(
            &providers,
            index_opened,
            Arc::clone(&settings),
        ));
        self.providers = Some(providers);
        // Settles what the last stop left before any follow of the log or any folder watch starts.
        recovery.run(&self.work_stop).await;
        // Right after the recovery pass, so the sweep reads what the last stop left before the
        // session services' follows begin.
        self.attention = Some(attention.start(self.work_stop.clone()).await?);
        self.workspace_work
            .as_mut()
            .expect("the workspace services are built before their work begins")
            .start();
        let session = self
            .session
            .as_ref()
            .expect("the session services are built before their follows begin");
        self.session_attachments = Some(start_session_attachments(session, &followers).await?);
        let repo = self
            .repo
            .as_ref()
            .expect("the repository services are built before their work begins");
        self.repo_attachments = Some(start_repo_attachments(repo, &followers).await?);
        schedule_jobs(
            &scheduler,
            JobDeps {
                writer,
                diagnostic_expiry: Arc::new(DiagnosticExpiryDeps {
                    data_folder: data_folder.clone(),
                    live_files: live_diagnostic_files(service_log_files, Arc::clone(&drivers)),
                    configuration,
                    reads,
                    drivers,
                }),
                data_folder,
                settings,
                backups,
            },
        )
        .await?;
        artifacts
            .start(&scheduler)
            .map_err(DaemonStartError::ArtifactReaper)?;
        // A stop leaves the registration to the stop, which ends it within the drain bound.
        tokio::select! {
            finished = registration.finished() => {
                finished.map_err(DaemonStartError::ProvidersRegistration)?;
            }
            () = self.work_stop.cancelled() => {}
        }
        self.check_stop("waiting for the providers' first reads")?;
        // Once the drivers are read, the runs a stop left waiting are delivered again.
        for (session_id, error) in queue
            .recover()
            .await
            .map_err(|error| DaemonStartError::QueueRecovery(Box::new(error)))?
        {
            tracing::warn!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a session's waiting runs could not be recovered, so they wait for its next send"
            );
        }
        self.process_state.mark_ready();
        tracing::info!(
            process_id = std::process::id(),
            protocol = CURRENT_PROTOCOL_VERSION,
            "{DAEMON_READY_LINE}"
        );
        Ok(())
    }

    // Fails with [`DaemonStartError::Stopped`] once a stop has come, naming the `step` just done.
    fn check_stop(&self, step: &'static str) -> Result<(), DaemonStartError> {
        if self.work_stop.is_cancelled() {
            return Err(DaemonStartStoppedError { step }.into());
        }
        Ok(())
    }

    // Releases what a failed start took, in the stop's order, keeping each failure beside `error`.
    async fn release(mut self, error: DaemonStartError) -> DaemonStartFailure {
        let release_started = Instant::now();
        let mut failures =
            stop_work(&mut self, DaemonStopIntent::Stop, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(close_data_folder(&mut self).await);
        DaemonStartFailure {
            failures: Box::new(CleanupFailures::new(error, failures, START_OPERATION)),
            release_started,
        }
    }

    /// The stop asked for over the socket: the lifecycle methods' stop asks with
    /// [`DaemonStopIntent::Stop`], their restart with [`DaemonStopIntent::Restart`], and the
    /// erase's end with [`DaemonStopIntent::Stop`]; the first ask wins.
    pub(crate) fn accept_stop(&self) -> Arc<dyn Fn(DaemonStopIntent) + Send + Sync> {
        let stop_asked = self.stop_asked.clone();
        Arc::new(move |intent| {
            stop_asked.send_if_modified(|asked| {
                let is_first = asked.is_none();
                if is_first {
                    *asked = Some(intent);
                }
                is_first
            });
        })
    }

    /// The erase's step that ends the daemon's work as the stop does.
    pub(crate) fn stop_work_step(&self) -> EraseStep {
        self.command_step(DaemonCommand::StopWork)
    }

    /// The erase's step that closes everything that holds a file in the data folder.
    pub(crate) fn close_data_folder_step(&self) -> EraseStep {
        self.command_step(DaemonCommand::CloseDataFolder)
    }

    // An erase step that sends the command `command` makes to the task that owns the process and
    // waits until it ran. Once the stop has begun, the stop closes these parts instead, and the
    // erase's later steps race the runtime's end.
    fn command_step(&self, command: fn(oneshot::Sender<()>) -> DaemonCommand) -> EraseStep {
        let commands = self.command_sender.clone();
        Arc::new(move || {
            let commands = commands.clone();
            async move {
                let (reply, replied) = oneshot::channel();
                if commands.send(command(reply)).await.is_err() || replied.await.is_err() {
                    tracing::info!(
                        "the daemon's stop had begun before the erase's step, so the stop closes \
                         those parts"
                    );
                }
            }
            .boxed()
        })
    }

    /// Runs the erase's steps as they come, until the first stop asked for: the system's stop
    /// request, which stops, damage found in the database file, which restarts so the next start
    /// repairs it, or a stop or restart over the socket, which the erase's end asks for.
    pub(crate) async fn wait_for_stop(&mut self) -> DaemonStopIntent {
        let mut stop_asked = self.stop_asked.subscribe();
        let damage = self
            .database
            .as_ref()
            .map(|database| Arc::clone(&database.damage));
        loop {
            let command = tokio::select! {
                () = self.system_stop.cancelled() => return DaemonStopIntent::Stop,
                () = async {
                    match &damage {
                        Some(damage) => {
                            damage.when_found().await;
                        }
                        None => std::future::pending().await,
                    }
                } => return DaemonStopIntent::Restart,
                asked = stop_asked.wait_for(Option::is_some) => return match asked.as_deref() {
                    Ok(Some(intent)) => *intent,
                    // The process holds the sender, so the wait ends only with an ask.
                    Ok(None) | Err(_) => DaemonStopIntent::Stop,
                },
                Some(command) = self.commands.recv() => command,
            };
            self.run_command(command).await;
        }
    }

    // Runs one of the erase's steps, logging each failure, and answers that it ran.
    async fn run_command(&mut self, command: DaemonCommand) {
        let (failures, reply) = match command {
            DaemonCommand::StopWork(reply) => (
                stop_work(self, DaemonStopIntent::Stop, DAEMON_STOP_DRAIN_BOUND).await,
                reply,
            ),
            DaemonCommand::CloseDataFolder(reply) => (close_data_folder(self).await, reply),
        };
        for failure in &failures {
            tracing::error!(
                error = failure as &(dyn Error + 'static),
                "a step of the erase's stop failed"
            );
        }
        if reply.send(()).is_err() {
            tracing::debug!("the erase ended before its step answered");
        }
    }

    /// Stops the daemon for `intent`: its work within the drain bound, then its data folder; a
    /// part the erase already closed is skipped. Fails with every step's failure, each step having
    /// run.
    pub(crate) async fn stop(
        mut self,
        intent: DaemonStopIntent,
    ) -> Result<(), SettleFailures<DaemonStopFailure>> {
        let mut failures = stop_work(&mut self, intent, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(close_data_folder(&mut self).await);
        settle_all(
            failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "the daemon's stop",
        )
        .map(drop)
    }
}
