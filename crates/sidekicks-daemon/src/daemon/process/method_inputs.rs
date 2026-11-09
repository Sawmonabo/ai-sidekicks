//! What the daemon's start builds over its store, its providers and its repository services for the
//! serving socket: the MCP services, the session directory's port, the session services, the MCP
//! server sign-ins, the terminals' table, the project and clone services, the worktree creator and
//! its setup card, the workspace services, the recovery services and the stored data's methods,
//! then every method table registered over them; it hands back the parts the start runs next and
//! the stop ends.

pub(crate) mod error;
pub(crate) mod mcp;
mod recovery;
mod worktree;

use std::error::Error;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use futures::FutureExt as _;
use jiff::Timestamp;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_ipc::registry::{HandlerError, MethodRegistryBuilder};
use sidekicks_mcp::client::McpClient;
use sidekicks_mcp::client::dispatch::McpToolDispatch;
use sidekicks_mcp::inventory_service::McpInventoryService;
use sidekicks_mcp::mutation::service::McpMutationService;
use sidekicks_mcp::sign_in::service::SignInService;
use sidekicks_mcp::sign_in::sign_out::owed::OwedSignOuts;
use sidekicks_platforms::{
    DaemonRunFolder, Spawner, TOOL_MEMORY_CAP_ENFORCEABLE, WallClock, available_memory,
    physical_memory, read_process_peak_bytes,
};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::account::credential_home::{ACCOUNT_SIGN_OUT_BOUND, sign_out_every_home};
use sidekicks_provider::port::run_pause::ContinuedMessages;
use sidekicks_provider::port::session_wake::SessionWaker;
use sidekicks_queue::memory_gate::{
    INGEST_WORKER_BYTES, MemoryGate, MemoryGateFigures, QUICK_THREAD_BYTES,
};
use sidekicks_queue::run_token_limit::RunTokenLimitReader;
use sidekicks_queue::service::answer_continue::HaltedRunRecord;
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::restart_settle::RestartSettle;
use sidekicks_recovery::startup::StartupRecovery;
use sidekicks_recovery::stop_intent::StopIntentFile;
use sidekicks_session::agent_tree::controls::ChildRunControls;
use sidekicks_session::agent_tree::lookup::StoredAgentTreeLookup;
use sidekicks_session::attention::banner_launcher::BannerLauncher;
use sidekicks_session::attention::delivery::web_address::sender::{
    WebAddressSender, WebAddressSenderDependencies,
};
use sidekicks_session::attention::service::{AttentionService, AttentionServiceDependencies};
use sidekicks_session::changes::UnarchivedCreateListener;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::groups::service::SessionGroupService;
use sidekicks_session::interventions::service::InterventionService;
use sidekicks_session::plan_holds::PlanHolds;
use sidekicks_session::run::held_tool_calls::StoredHeldToolCalls;
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_shell::orphan::guard::OrphanGuard;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::machine::identity_key::MachineIdentity;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_workspace::clone::service::{CloneAttachedListener, CloneService, CloneServiceDeps};
use sidekicks_workspace::folder::list::FolderListService;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::creation::WorktreeCreator;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupRunner;
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
use crate::daemon::process::method_inputs::error::MethodInputsError;
use crate::daemon::process::method_inputs::mcp::{
    McpGovernanceStart, McpSignInStart, build_sign_ins, open_mcp_status,
};
use crate::daemon::process::method_inputs::recovery::{
    RecoveryServiceStart, RecoveryServices, build_recovery_services,
};
use crate::daemon::process::method_inputs::worktree::{
    WorktreeServiceStart, WorktreeServices, build_worktree_services,
};
use crate::daemon::process::method_tables::{MethodTableServices, register_method_tables};
use crate::daemon::process::provider_accounts::{
    ProviderAccountObservation, ProviderAccountPlaneStart, build_provider_account_plane,
};
use crate::daemon::process::provider_port::{ProviderPortStart, build_provider_port};
use crate::daemon::process::providers::{
    DriverPortOwners, Providers, native_session_places, register_driver_ports,
};
use crate::daemon::process::repo_services::{
    ManagedWritesWatermarkFile, RepoServices, managed_writes_watermark_path,
};
use crate::daemon::process::session_services::{
    SessionServiceStart, SessionServices, build_session_services,
};
use crate::daemon::process::shell_table::{ShellTableStart, build_shell_table};
use crate::daemon::process::stop::DaemonStopReason;
use crate::daemon::process::supervision::ProcessStateTracker;
use crate::daemon::process::workspace_services::{
    ExecutionRootStart, WorkspaceServiceStart, WorkspaceWork, build_execution_root_services,
    build_workspace_services,
};
use crate::daemon::process_tree_usage::ProcessTreeUsageReader;
use crate::daemon::status_methods::StatusMethodsDeps;
use crate::data_acts::erase::{DataErase, DataEraseDeps, EraseStep};
use crate::data_acts::export::{DataExportDeps, DataExports};
use crate::ipc::handlers::agent::command::CommandMethodSources;
use crate::ipc::handlers::approval::ApprovalMethodSources;
use crate::ipc::handlers::driver::DriverMethodSources;
use crate::ipc::handlers::mcp::McpMethodSources;
use crate::ipc::handlers::run::control::RunControlServices;
use crate::ipc::handlers::run::queue::RunQueueMethods;
use crate::ipc::handlers::session::controls::SessionControlMethods;
use crate::ipc::handlers::session::mcp_servers::McpServerMethods;
use crate::ipc::handlers::session::search::SessionSearchMethods;
use crate::ipc::handlers::session::snapshots::SessionSnapshotSources;
use crate::observability::diagnostic_buckets::recorders::{
    provider_messages_folder, raw_message_recorder, tool_trace_recorder,
};
use crate::orchestration::goal_service::SessionGoals;

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
    /// This machine's device id, which a run's hold on a shell names.
    pub(crate) machine_device_id: DeviceId,
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
    /// This machine's two keys, started on their own task.
    pub(crate) machine_identity: Arc<MachineIdentity>,
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
    /// The record of every child of the daemon, opened by the start.
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
    /// Starts the daemon's stop for the reason given.
    pub(crate) accept_stop: Arc<dyn Fn(DaemonStopReason) + Send + Sync>,
    /// The intent the person's Stop writes, which the recovery pass reads and a purge drops from.
    pub(crate) stop_intent: Arc<StopIntentFile>,
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
    /// The restart's settle, which the person's Stop drains the live runs through.
    pub(crate) restart_settle: Arc<RestartSettle>,
    /// The live projects list, closed at the stop.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
    /// The clone service, which owns the askpass broker and closes it at the stop; `None` when it
    /// could not start.
    pub(crate) clones: Option<Arc<CloneService>>,
    /// The setup card of every worktree made, whose running commands the stop ends.
    pub(crate) worktree_setup: Arc<WorktreeSetupRunner>,
    /// Makes worktrees and answers the new-worktree form's suggestion.
    pub(crate) worktree_creator: Arc<WorktreeCreator>,
    /// This machine's device, the device of every connection to its socket.
    pub(crate) machine_device_id: DeviceId,
    /// The devices' heartbeats, which the presence methods answer from and each closing
    /// connection drops its own from.
    pub(crate) presence: Arc<PresenceRegister>,
    /// The attention service, started right after the recovery pass.
    pub(crate) attention: Arc<AttentionService>,
    /// The web address's sender, started right after the attention service.
    pub(crate) web_address_sender: Arc<WebAddressSender>,
    /// The workspace services' work, which the start begins once the recovery pass has ended.
    pub(crate) workspace_work: WorkspaceWork,
    /// The MCP server inventory, whose fills of the attribution table the start begins.
    pub(crate) mcp_inventory: Arc<McpInventoryService>,
    /// The MCP binding edits' service, whose pass over the edits a stop left unfinished the start
    /// requests.
    pub(crate) mcp_mutations: Arc<McpMutationService>,
    /// The MCP server sign-ins, whose open attempts the stop closes.
    pub(crate) mcp_sign_ins: Arc<SignInService>,
    /// The sign-outs the MCP bindings' removals owe, which the start settles.
    pub(crate) mcp_owed_sign_outs: Arc<OwedSignOuts>,
    /// The provider accounts' background observer, started once the recovery pass has run.
    pub(crate) provider_accounts: ProviderAccountObservation,
    /// The daemon's one client of the sessions' tool servers, which the stop stops.
    pub(crate) mcp_client: Arc<McpClient>,
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
        machine_device_id,
        scheduler,
        search_index,
        clock,
        spawner,
        git,
        base_environment,
        shell_lines,
        authorizer,
        secret_items,
        machine_identity,
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
        stop_intent,
        stop_work,
        close_data_folder,
    } = start;
    let wake_helper_spawner = spawner.clone();
    let resource_copy_spawner = spawner.clone();
    let presence = Arc::new(PresenceRegister::default());
    let reads = Arc::clone(&database.pool);
    let writer = Arc::clone(&database.writer);
    let read_damaged_from_sequence = Arc::clone(&database.read_damaged_from_sequence);
    let registry = Arc::clone(&providers.registry);
    let settings_reader: Arc<dyn MachineSettingsReader> = Arc::clone(&settings) as _;
    let epochs = Arc::clone(&providers.epochs);
    let binding_cursors = Arc::clone(&providers.binding_cursors);
    let mcp = open_mcp_status(&writer, &reads).await;
    let port = build_provider_port(ProviderPortStart {
        reads: Arc::clone(&reads),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
        binding_cursors: Arc::clone(&binding_cursors),
        git: git.clone(),
        settings: Arc::clone(&settings_reader),
        plan_holds: plan_holds.as_ref(),
        ports: &providers.ports,
        mcp_status: Arc::clone(&mcp.status),
        mcp_attribution: Arc::clone(&mcp.attribution),
        mcp_tool_servers: Arc::clone(&mcp.session_tool_servers),
    })?;
    let mcp_inventory = mcp.build_governance(&McpGovernanceStart {
        providers: &registry,
        projects: &port.project_records,
        reads: &reads,
    });
    mcp.session_tool_servers
        .register_inventory(Arc::clone(&mcp_inventory))?;
    let WorktreeServices {
        setup: worktree_setup,
        live_run_folders,
        creator: worktree_creator,
    } = build_worktree_services(WorktreeServiceStart {
        reads: &reads,
        writer: &writer,
        repo,
        records: &port.project_records,
        settings: &settings_reader,
        base_environment: &base_environment,
        reserved_names: &providers.reserved_names,
        git: git.clone(),
        spawner: spawner.clone(),
    });
    // The creator's, the run setup gate's around a run's context write, and the turn snapshots'.
    let checkout_lock = Arc::clone(&repo.checkout_lock);
    let attention = Arc::new(AttentionService::new(AttentionServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::clone(&reads),
        changes: database.attention_changes.clone(),
        settings: Arc::clone(&settings_reader),
        presence: Arc::clone(&presence),
        launcher: Arc::new(BannerLauncher::new(Arc::new(spawner.clone()))),
        machine_device_id: machine_device_id.clone(),
        scheduler: Arc::clone(&scheduler),
    }));
    let web_address_sender = Arc::new(WebAddressSender::new(WebAddressSenderDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::clone(&reads),
        changes: database.attention_changes.clone(),
        settings: Arc::clone(&settings_reader),
        keychain: Arc::new(secret_items.keychain(KeychainService::DeliverySecrets)),
        scheduler: Arc::clone(&scheduler),
        clock: Arc::clone(&clock),
    }));
    let project_list_feed = Arc::new(ProjectListFeed::new(
        Arc::clone(&port.project_records),
        &database.followers,
    ));
    let roots = build_execution_root_services(ExecutionRootStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        git: git.clone(),
        repo,
        creator: Arc::clone(&worktree_creator),
        setup: Arc::clone(&worktree_setup),
        live_run_folders,
        checkout_lock,
        project_list_feed: Arc::clone(&project_list_feed),
    });
    // The daemon's `Tokens per run`, which run admission admits each new lead run with.
    let token_limits = PortRegistration::new("run token limits");
    token_limits.register(Arc::clone(&configuration) as Arc<dyn RunTokenLimitReader>)?;
    let session = build_session_services(SessionServiceStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        event_log: Arc::clone(&database.event_log),
        followers: Arc::clone(&database.followers),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
        providers: Arc::clone(&registry),
        execution_postures: Arc::clone(&providers.execution_postures),
        execution_root_gate: Arc::clone(&roots.gate) as _,
        binding_cursors,
        epochs,
        compose_opening: port.compose_opening,
        read_git_folder: port.read_git_folder,
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
        snapshots: Arc::clone(&repo.snapshots),
        list_feed: Arc::clone(&list_feed),
        plan_holds,
        payloads: Arc::clone(&artifacts.payloads),
        publisher: Arc::clone(&artifacts.publisher),
        attachments: Arc::clone(&artifacts.attachments),
        spool_folder: artifacts.spool_folder.clone(),
        workspaces_folder: managed_workspaces_folder(home_folder),
        workspace_writes: repo
            .workspace_writes
            .take()
            .expect("the start takes the chats' writes once"),
        // The one keeper of the instant the chats' write watch walks from at the next start.
        managed_writes_watermark: Arc::new(ManagedWritesWatermarkFile {
            path: managed_writes_watermark_path(home_folder),
        }),
        clock: Arc::clone(&clock),
        spawner,
        daemon_program: daemon_program.to_path_buf(),
        provider_accounts: Arc::clone(&providers.ports.provider_accounts),
        token_limits: Arc::new(token_limits),
        halted_runs: Arc::clone(&database.status) as Arc<dyn HaltedRunRecord>,
        scheduler: Arc::clone(&scheduler),
        mcp_status: Arc::clone(&mcp.status),
        mcp_first_observations: mcp.first_observations,
    })?;
    let mcp_sign_ins = build_sign_ins(&McpSignInStart {
        providers: &registry,
        inventory: &mcp_inventory,
        board: &mcp.board,
        provider_accounts: &providers.ports.provider_accounts,
        settings: &settings_reader,
        projects: &port.project_records,
        secret_items: &secret_items,
        writer: &writer,
        reads: &reads,
        appender: &session.appender,
    })
    .map_err(MethodInputsError::McpSignInPools)?;
    let accounts = build_provider_account_plane(ProviderAccountPlaneStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        data_folder,
        provider_tokens: Arc::new(secret_items.keychain(KeychainService::ProviderTokens)),
        providers: Arc::clone(&registry),
        usage: Arc::clone(&session.usage),
        binding_cursors: Arc::clone(&session.binding_cursors),
        scheduler: Arc::clone(&scheduler),
        clock,
        machine_device_id: machine_device_id.clone(),
        spawner: wake_helper_spawner,
        daemon_program,
        provider_sessions: Arc::clone(&session.provider_sessions),
        appender: Arc::clone(&session.appender),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
        request_held: Arc::clone(&providers.ports.request_held),
        daemon_started_at: WireInstant::from_timestamp(started_at)
            .expect("the clock reads after year 0000"),
    })
    .await;
    let mcp_client = Arc::new(McpClient::new(
        Arc::clone(&providers.ports.questions),
        version.clone(),
    )?);
    let mcp_dispatch = Arc::new(McpToolDispatch::new(Arc::clone(&writer)));
    register_driver_ports(
        &providers.ports,
        DriverPortOwners {
            provider_accounts: accounts.reader,
            provider_account_registry: accounts.registry,
            session_account_moves: accounts.account_move_record,
            account_home_lock: accounts.home_lock,
            run_engine: Arc::clone(&session.engine),
            inbound_dispatch: Arc::clone(&session.inbound_dispatch),
            queue_admission: session.queue.admission(),
            queue_delivery: session.queue.delivery(),
            process_gone: session.queue.process_gone_listener(),
            continue_given_back: session.queue.continue_given_back_listener(),
            permission_asks: Arc::clone(&session.approvals.asks),
            questions: Arc::clone(&session.questions),
            server_prompts: Arc::clone(&mcp_client) as _,
            plans: Arc::clone(&session.plans),
            reviewer_denials: Arc::clone(&session.approvals.denials),
            writer: Arc::clone(&writer),
            approval_rules: Arc::clone(&session.approvals.rules),
            session_places: native_session_places(&base_environment),
            run_pauses: Arc::clone(&session.pauses),
            usage: Arc::clone(&session.usage),
            running_commands: Arc::clone(&session.running_commands),
            turn_readings: Arc::clone(&session.turn_readings),
            context_readings: Arc::clone(&session.context_readings),
            tool_call_statuses: Arc::clone(&session.tool_call_statuses),
            held_tool_calls: Arc::new(StoredHeldToolCalls::new(Arc::clone(&reads))),
            agent_tree_lookup: Arc::new(StoredAgentTreeLookup::new(Arc::clone(&reads))),
            idle_sleep: Arc::clone(&session.idle_sleep),
            session_resumes: Arc::clone(&session.stored_resumes),
            provider_sessions: Arc::clone(&session.provider_sessions),
            raw_provider_messages: Arc::new(raw_message_recorder(data_folder, &configuration)),
            tool_traces: Arc::new(tool_trace_recorder(data_folder, &configuration)),
        },
    )?;
    let shells = Arc::new(
        build_shell_table(ShellTableStart {
            terminals: Arc::clone(&session.terminals),
            machine_device_id: machine_device_id.clone(),
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
            release_version: version.clone(),
        })
        .await?,
    );
    let driver_set_names = providers.reserved_names.names().to_vec();
    let projects = Arc::new(ProjectService::new(ProjectServiceDeps {
        writer: Arc::clone(&writer),
        records: Arc::clone(&port.project_records),
        mounts: Arc::clone(&repo.mounts),
        sessions: Arc::clone(&session.changes) as _,
        git: git.clone(),
        settings: Arc::clone(&settings_reader),
        driver_set_names: driver_set_names.clone(),
        worktrees_folder: repo.worktrees_folder.clone(),
        list_feed: Arc::clone(&project_list_feed),
    }));
    let workspace = build_workspace_services(WorkspaceServiceStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        event_log: Arc::clone(&database.event_log),
        git: git.clone(),
        repo,
        roots: &roots,
        creator: Arc::clone(&worktree_creator),
        setup: Arc::clone(&worktree_setup),
        shells: Arc::clone(&shells),
        appender: Arc::clone(&session.appender),
        providers: Arc::clone(&registry),
        settings: Arc::clone(&settings_reader),
        changes: Arc::clone(&session.changes),
        projects: Arc::clone(&projects),
        records: Arc::clone(&port.project_records),
        project_list_feed: Arc::clone(&project_list_feed),
        scheduler: Arc::clone(&scheduler),
    });
    // The create finishes the sessions a clone holds once it attaches, and a session unarchived
    // before its create finished.
    let clone_attached = Arc::new(PortRegistration::new("clone attached"));
    clone_attached.register(Arc::clone(&workspace.creation) as Arc<dyn CloneAttachedListener>)?;
    session
        .changes
        .unarchived_creates()
        .register(Arc::clone(&workspace.creation) as Arc<dyn UnarchivedCreateListener>)?;
    let clones = match repo
        .askpass
        .take()
        .expect("the start takes the askpass broker once")
    {
        Ok(askpass) => CloneService::start(CloneServiceDeps {
            projects: Arc::clone(&projects),
            records: Arc::clone(&port.project_records),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&writer),
            askpass,
            settings: Arc::clone(&settings_reader),
            home_folder: home_folder.to_path_buf(),
            git: git.clone(),
            clone_attached,
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
    let RecoveryServices {
        stored,
        recovery,
        restart_settle,
    } = build_recovery_services(RecoveryServiceStart {
        database,
        reads: &reads,
        writer,
        session: &session,
        repo,
        providers,
        registry: &registry,
        artifacts,
        shells: &shells,
        mcp_client: &mcp_client,
        project_list_feed: &project_list_feed,
        machine_id: machine.machine_id,
        configuration: &configuration,
        scheduler: &scheduler,
        backups: &backups,
        in_flight,
        accept_stop: &accept_stop,
        data_folder,
        copier,
        stop_intent,
        mcp_dispatch,
    })?;
    let driver_methods = Arc::new(DriverMethodSources {
        pool: Arc::clone(&reads),
        providers: Arc::clone(&registry),
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
    });
    // The messages waiting for a paused run, which a run's and a child's continue deliver.
    let continued: Arc<dyn ContinuedMessages> = Arc::new(session.queue.delivery());
    let (erase_reads, erase_data_folder, erase_legs, erase_sign_ins) = (
        Arc::clone(&reads),
        data_folder.to_path_buf(),
        accounts.methods.account_legs.clone(),
        Arc::clone(&accounts.methods.sign_in),
    );
    register_method_tables(
        builder,
        MethodTableServices {
            status: StatusMethodsDeps {
                process_identity,
                read_process_state: Arc::new(move || process_state.read()),
                recovery: Arc::clone(&database.status),
                reads: Arc::clone(&reads),
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
                machine_identity,
                accounts: Arc::clone(&accounts.methods.accounts),
                wake_helper: accounts.methods.wake_helper.clone(),
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
                settings_file: Arc::clone(&settings),
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
                    sign_out_accounts: Arc::new(move || {
                        let (pool, legs) = (Arc::clone(&erase_reads), erase_legs.clone());
                        let folder = erase_data_folder.clone();
                        async move {
                            sign_out_every_home(&pool, &folder, &legs, ACCOUNT_SIGN_OUT_BOUND).await
                        }
                        .boxed()
                    }),
                    end_sign_ins: Arc::new(move || {
                        let sign_ins = Arc::clone(&erase_sign_ins);
                        async move { sign_ins.stop(ACCOUNT_SIGN_OUT_BOUND).await }.boxed()
                    }),
                    close_data_folder,
                    end_process: Arc::new(move || accept_stop(DaemonStopReason::Erase)),
                })),
            },
            data_folder: data_folder.to_path_buf(),
            driver_methods: Arc::clone(&driver_methods),
            approval_methods: Arc::new(ApprovalMethodSources {
                pool: Arc::clone(&reads),
                permission_asks: Arc::clone(&session.approvals.asks),
                rules: Arc::clone(&session.approvals.rules),
                reviewer_denials: Arc::clone(&session.approvals.denials),
                queue: Arc::clone(&session.queue),
            }),
            run_control: RunControlServices {
                interventions: Arc::clone(&session.interventions),
                pauses: Arc::clone(&session.pauses),
                choices: Arc::clone(&session.choices),
                continued: Arc::clone(&continued),
            },
            child_run_controls: Arc::new(ChildRunControls::new(
                Arc::clone(&reads),
                Arc::clone(&registry),
                InterventionService::clone(&session.interventions),
                Arc::clone(&session.pauses),
                continued,
                Arc::clone(&session.appender),
                Arc::clone(&read_damaged_from_sequence),
            )),
            command_methods: Arc::new(CommandMethodSources {
                pool: Arc::clone(&reads),
                running: Arc::clone(&session.running_commands),
                providers: Arc::clone(&registry),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
            }),
            turn_readings: Arc::clone(&session.turn_readings),
            tool_call_statuses: Arc::clone(&session.tool_call_statuses),
            context_readings: Arc::clone(&session.context_readings),
            providers: Arc::clone(&registry),
            run_queue: RunQueueMethods {
                queue: Arc::clone(&session.queue),
                log: Arc::clone(&database.event_log),
                pool: Arc::clone(&reads),
                signals: Arc::clone(&session.signals),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
            },
            event_log: Arc::clone(&database.event_log),
            mcp_methods: McpMethodSources {
                log: Arc::clone(&database.event_log),
                board: mcp.board,
                inventory: Arc::clone(&mcp_inventory),
                mutations: Arc::clone(&mcp_sign_ins.mutations),
                sign_ins: mcp_sign_ins.commands,
            },
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
            mcp_client: Arc::clone(&mcp_client),
            review_notes: Arc::clone(&repo.review_notes),
            session_snapshots: SessionSnapshotSources {
                reads: Arc::clone(&reads),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
            },
            session_search: SessionSearchMethods {
                index: search_index,
                files: Arc::clone(&session.file_search),
                read_damaged_from_sequence,
            },
            mcp_servers: McpServerMethods {
                sources: Arc::clone(&driver_methods),
                statuses: mcp.status,
                client: Arc::clone(&mcp_client),
                spawner: resource_copy_spawner,
                reserved_names: Arc::clone(&providers.reserved_names),
                followers: Arc::clone(&database.followers),
            },
            session_goals: Arc::new(SessionGoals {
                pool: Arc::clone(&reads),
                providers: Arc::clone(&registry),
                session_wakes: Arc::clone(&session.idle_sleep) as Arc<dyn SessionWaker>,
            }),
            session_controls: SessionControlMethods {
                sources: driver_methods,
                provider_sessions: Arc::clone(&session.provider_sessions),
                run_queue: Arc::clone(&session.queue),
            },
            session_max_steps: Arc::clone(&database.writer),
            branches: Arc::clone(&repo.branches),
            working_folders: Arc::clone(&repo.folder_watch),
            projects,
            project_list_feed: Arc::clone(&project_list_feed),
            clones: clones.clone(),
            machine_folders: Arc::new(FolderListService::new(home_folder.to_path_buf(), git)),
            presence: Arc::clone(&presence),
            attention: Arc::clone(&attention),
            web_address_sender: Arc::clone(&web_address_sender),
            repo_mounts: workspace.repo_mounts,
            workspaces: roots.workspaces,
            execution_roots: roots.execution_roots,
            worktree_methods: workspace.worktree_methods,
            session_creation: workspace.creation,
            session_conversion: workspace.conversion,
            session_working_folders: roots.session_working_folders,
            machine_settings_file: settings,
            provider_accounts: accounts.methods,
        },
    )?;
    Ok(MethodInputs {
        session,
        recovery,
        restart_settle,
        project_list_feed,
        clones: clones.ok(),
        worktree_setup,
        worktree_creator,
        machine_device_id,
        presence,
        attention,
        web_address_sender,
        workspace_work: workspace.work,
        mcp_inventory,
        mcp_mutations: mcp_sign_ins.mutations,
        mcp_sign_ins: mcp_sign_ins.service,
        mcp_owed_sign_outs: mcp_sign_ins.owed_sign_outs,
        provider_accounts: accounts.observation,
        mcp_client,
    })
}

/// This machine's own device id, which the served socket and a run's hold on a shell name: a
/// machine's id is the device of every local connection to its service. Fails with
/// [`MethodInputsError::MachineDeviceId`] when the stored id is no device id.
pub(crate) fn device_id_of(machine_id: &MachineId) -> Result<DeviceId, MethodInputsError> {
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
