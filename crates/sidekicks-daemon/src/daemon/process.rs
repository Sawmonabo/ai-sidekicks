//! The running daemon: its start, in the order each service needs the ones before it, whose steps
//! its `start` module runs, and its stop, in the reverse order, carrying why it stops, which its
//! `stop` module runs. A start that fails releases what it took, in the stop's order, and names
//! the step that failed.

mod approvals;
mod crash_monitor;
pub(crate) mod damage_gate;
pub(crate) mod database;
pub(crate) mod jobs;
mod mcp_attribution;
pub(crate) mod method_inputs;
pub(crate) mod method_tables;
mod projections;
mod provider_accounts;
mod provider_port;
pub(crate) mod providers;
mod repo_services;
mod session_services;
mod shell_table;
pub(crate) mod start;
pub(crate) mod stop;
mod stored_data;
pub(crate) mod supervision;
#[cfg(test)]
mod tests;
pub(crate) mod workspace_services;
mod worktree_sources;

use std::sync::Arc;
use std::time::{Duration, Instant};

use jiff::Timestamp;
use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_DRAIN_BOUND_MS;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_mcp::client::McpClient;
use sidekicks_mcp::mutation::service::McpMutationService;
use sidekicks_mcp::sign_in::service::SignInService;
use sidekicks_platforms::Spawner;
use sidekicks_recovery::restart_settle::RestartSettle;
use sidekicks_recovery::startup::StartupRecovery;
use sidekicks_recovery::stop_intent::StopIntentFile;
use sidekicks_session::run::turn_capture::TurnCapturing;
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_shell::orphan::guard::OrphanGuard;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::data_folder::lock::DataFolderLock;
use sidekicks_store::database::connection::writer_open::DAEMON_DATABASE_FILE_NAME;
use sidekicks_store::machine::identity_key::MachineIdentity;
use sidekicks_workspace::clone::service::CloneService;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::creation::WorktreeCreator;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupRunner;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::process::crash_monitor::CrashMonitor;
use crate::daemon::process::database::DatabaseFile;
use crate::daemon::process::jobs::IdleMemoryCollect;
use crate::daemon::process::mcp_attribution::McpAttributionFills;
use crate::daemon::process::provider_accounts::ProviderAccountObservation;
use crate::daemon::process::providers::pricing::PricingTasks;
use crate::daemon::process::providers::{Providers, ProvidersRegistration};
use crate::daemon::process::repo_services::{RepoAttachments, RepoServices};
use crate::daemon::process::session_services::{SessionAttachments, SessionServices};
use crate::daemon::process::start::error::{DaemonStartError, DaemonStartFailure};
use crate::daemon::process::start::options::DaemonStartOptions;
use crate::daemon::process::stop::{
    DaemonCommand, DaemonStopReason, close_data_folder_contents, stop_work,
};
use crate::daemon::process::supervision::ProcessStateTracker;
use crate::daemon::process::workspace_services::WorkspaceWork;
use crate::daemon::service_status::{StopRecord, record_start_failure};
use crate::ipc::local_gateway::LocalGateway;

/// The longest the stop's drain runs, the work ending and the data folder closing together.
pub(crate) const DAEMON_STOP_DRAIN_BOUND: Duration =
    Duration::from_millis(DAEMON_STOP_DRAIN_BOUND_MS);

/// The running daemon: every service it started, held in the order its stop ends them, each part
/// a step closes taken as it closes, so a later stop skips it.
pub(crate) struct DaemonProcess {
    /// When the start began, which the status read reports.
    pub(crate) started_at: Timestamp,
    /// The system's stop request.
    system_stop: CancellationToken,
    /// Why a stop was asked for over the socket, each ask joined to the one before it.
    stop_asked: watch::Sender<Option<DaemonStopReason>>,
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
    /// The record of every child of the daemon, closed once the terminals have drained.
    pub(crate) orphan_guard: Option<Arc<OrphanGuard>>,
    /// The crash monitor, ended before the data folder's lock goes.
    pub(crate) crash_monitor: Option<CrashMonitor>,
    /// The hold on the data folder, let go last.
    pub(crate) data_folder_lock: Option<DataFolderLock>,
    /// The database file, closed first as the data folder closes.
    pub(crate) database: Option<DatabaseFile>,
    /// This machine's two keys, whose background read the stop joins within the drain bound.
    pub(crate) machine_identity: Option<Arc<MachineIdentity>>,
    /// When the latest stop began, from which what is left of its drain bound is counted.
    pub(crate) stop_started: Option<Instant>,
    /// The intent the person's Stop writes beside the database file, held from before the file
    /// opens, so a Stop that cuts the start short writes it too.
    pub(crate) stop_intent: Arc<StopIntentFile>,
    /// Whether a step of the stop failed, so no clean stop is recorded.
    pub(crate) has_stop_failed: bool,
    /// The record in the status file of each stop of the running service: each step it waits on
    /// and how it ended.
    pub(crate) stop_record: StopRecord,
    /// Hands freed memory back once the work goes quiet; ends with the work.
    idle_memory: Option<Arc<IdleMemoryCollect>>,
    /// Runs the background jobs, stopped as the work ends.
    pub(crate) scheduler: Option<Arc<Scheduler>>,
    /// The session search index, closed as the work ends, a close cut there waited out as the
    /// data folder closes.
    pub(crate) search_index: Option<Arc<LiveIndex>>,
    /// The gate that records every mutating call while it runs, which the stop waits on.
    pub(crate) in_flight: Option<Arc<InFlightMutations>>,
    /// The providers, whose drivers the stop shuts down last.
    pub(crate) providers: Option<Providers>,
    /// The providers' first capability reads, ended by the stop before the drivers.
    pub(crate) providers_registration: Option<ProvidersRegistration>,
    /// The MCP attribution table's fills, ended by the stop before the drivers.
    pub(crate) mcp_attribution_fills: Option<McpAttributionFills>,
    /// The tool servers' client, stopped before the queue and the drivers.
    pub(crate) mcp_client: Option<Arc<McpClient>>,
    /// The MCP binding edits' service, whose settle pass the stop waits for before the drivers.
    pub(crate) mcp_mutations: Option<Arc<McpMutationService>>,
    /// The MCP server sign-ins, whose open attempts the stop closes before the drivers.
    pub(crate) mcp_sign_ins: Option<Arc<SignInService>>,
    /// The repository services, whose watch, fetches and askpass broker the stop ends.
    pub(crate) repo: Option<RepoServices>,
    /// The repository services' background work, ended by the stop before the scheduler.
    pub(crate) repo_attachments: Option<RepoAttachments>,
    /// The session services: the stop ends the queue, the renames' name pushes, the highlighter
    /// and the terminals, and lets the rest go before the database file closes.
    pub(crate) session: Option<SessionServices>,
    /// What a restart or the person's Stop left in the sessions, settled; the person's Stop
    /// drains the live runs through it once the drivers are shut down.
    pub(crate) restart_settle: Option<Arc<RestartSettle>>,
    /// The session services' follows of the log, ended by the stop with the chats' write watch.
    pub(crate) session_attachments: Option<SessionAttachments>,
    /// The turn-end capture's follow, ended by the stop once the drivers can end no more turns.
    pub(crate) turn_capturing: Option<TurnCapturing>,
    /// The start's recovery pass, kept past it so the stop waits out the name drops it left
    /// waiting on a session's kept turns.
    pub(crate) recovery: Option<StartupRecovery>,
    /// The attention service's decision task, which ends with the work's stop and is waited out.
    pub(crate) attention: Option<JoinHandle<()>>,
    /// Keep-awake's task, which lets go of the hold at the work's stop and is waited out.
    pub(crate) keep_awake: Option<JoinHandle<()>>,
    /// The provider accounts' background observer, ended by the stop before the scheduler.
    pub(crate) provider_accounts: Option<ProviderAccountObservation>,
    /// The web address's sender, which ends with the work's stop and is waited out.
    pub(crate) web_address_sender: Option<JoinHandle<()>>,
    /// The price list's fetch and the repricing, which end with the work's stop and are waited out.
    pub(crate) pricing: Option<PricingTasks>,
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
    /// what the start took, in the stop's order, records why the start failed in the status file
    /// and fails with the step's error beside every failure of that release; a stop asked for
    /// before the daemon is ready fails it with [`DaemonStartError::Stopped`].
    pub(crate) async fn start(options: DaemonStartOptions) -> Result<Self, DaemonStartFailure> {
        let started_at = Timestamp::now();
        let spawner = match Spawner::new(tokio::runtime::Handle::current()) {
            Ok(spawner) => spawner,
            Err(error) => {
                let error = DaemonStartError::Spawner(error);
                // The lock `options` holds goes only once this returns, after the record.
                record_start_failure(&options.run_folder, &error).await;
                return Err(DaemonStartFailure {
                    failures: Box::new(CleanupFailures::new(error, Vec::new(), START_OPERATION)),
                    release_started: Instant::now(),
                });
            }
        };
        let (command_sender, commands) = mpsc::channel(1);
        let stop_intent = Arc::new(StopIntentFile::new(
            &data_folder(&options.home_folder).join(DAEMON_DATABASE_FILE_NAME),
        ));
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
            stop_intent,
            has_stop_failed: false,
            stop_record: StopRecord::new(
                options.run_folder.clone(),
                options.process_identity.clone(),
            ),
            idle_memory: None,
            scheduler: None,
            search_index: None,
            in_flight: None,
            providers: None,
            providers_registration: None,
            mcp_attribution_fills: None,
            mcp_client: None,
            mcp_mutations: None,
            mcp_sign_ins: None,
            repo: None,
            repo_attachments: None,
            session: None,
            restart_settle: None,
            session_attachments: None,
            turn_capturing: None,
            recovery: None,
            attention: None,
            keep_awake: None,
            provider_accounts: None,
            web_address_sender: None,
            pricing: None,
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

    // Releases what a failed start took, in the stop's order, for the reason `error` gives, keeping
    // each failure beside `error`. Why the start failed is recorded before the data folder's lock
    // goes last, so a start that takes the lock next meets no write of this one.
    async fn release(mut self, error: DaemonStartError) -> DaemonStartFailure {
        let release_started = Instant::now();
        let reason = DaemonStopReason::of_failed_start(&error);
        let mut failures = stop_work(&mut self, reason, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(close_data_folder_contents(&mut self).await);
        record_start_failure(&self.stop_record.run_folder, &error).await;
        drop(self.data_folder_lock.take());
        DaemonStartFailure {
            failures: Box::new(CleanupFailures::new(error, failures, START_OPERATION)),
            release_started,
        }
    }
}
