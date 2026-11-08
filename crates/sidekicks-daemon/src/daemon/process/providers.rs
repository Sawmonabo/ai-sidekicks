//! The providers at the daemon's start: every driver built once from the one bundle of shared
//! services, the capability refresh over them, the ports the drivers read registered once the
//! services behind them exist, and the drivers' first capability reads, which a provider with a
//! lasting service answers by connecting to it.

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_approval::permission_asks::PermissionAsks;
use sidekicks_approval::reviewer_denials::ReviewerDenials;
use sidekicks_approval::rules::ApprovalRules;
use sidekicks_artifact::plans::service::PlansService;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_platforms::{PathRules, Spawner, current_user_id};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::background_work::BackgroundWorkForms;
use sidekicks_provider::build_record::BuildRecordReaders;
use sidekicks_provider::capability::refresh::{CapabilityRefresher, CapabilityRefreshing};
use sidekicks_provider::command::running_set::RunningCommandSets;
use sidekicks_provider::command::waiting_checks::SystemInputWaitReader;
use sidekicks_provider::command_search::ProviderCommandSearch;
use sidekicks_provider::compaction_wait::PendingCompactionRegistry;
use sidekicks_provider::driver::attachments::AttachmentResolver;
use sidekicks_provider::driver::capabilities::writer::{
    CapabilityHydration, DriverCapabilitiesWriter,
};
use sidekicks_provider::driver::child_records::DaemonChildRecords;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_provider::driver::ports::{
    ContinueGivenBackListener, DriverPorts, ProcessGoneListener, SessionPlace,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{
    DriverServices, ProviderAccountReader, ProviderDescriptor, ProviderRegistration,
};
use sidekicks_provider::port::server_prompts::ServerPromptPort;
use sidekicks_provider::port::session_account_move::SessionAccountMoveRecorder;
use sidekicks_provider::port::session_level_follower::SessionLevelFollower;
use sidekicks_provider::process_registry::ProviderProcessRegistry;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_queue::admission::QueueAdmission;
use sidekicks_queue::delivery::QueueDelivery;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_session::addresses::{ForeignPlaceError, SessionInboxAddresses};
use sidekicks_session::agent_tree::lookup::StoredAgentTreeLookup;
use sidekicks_session::console_state::ConsoleStateAdvisors;
use sidekicks_session::idle_sleep::SessionIdleSleep;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::tool_call_status::ToolCallStatuses;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::epochs::{ExecutionEpochs, MAX_ASSOCIATIONS_PER_BINDING};
use sidekicks_session::run::held_tool_calls::StoredHeldToolCalls;
use sidekicks_session::run::inbound::RunInboundDispatch;
use sidekicks_session::run::pause::RunPauseControl;
use sidekicks_session::usage_record::UsageRecord;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::port_registration::PortRegistrationError;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;
use tokio::task::JoinError;
use tokio_util::task::AbortOnDropHandle;

use crate::daemon::process::session_services::stored_resumes::StoredSessionResumes;
use crate::program::dispatches_hook_mode;

pub(crate) mod pricing;
pub(crate) mod stored_rows;
#[cfg(test)]
mod test_start;

/// What the providers' build takes from the steps before it.
pub(crate) struct ProviderStart {
    /// The one thread every child process is spawned from.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's worktrees folder, its links resolved, where a staged review's tree is made.
    pub(crate) worktrees_folder: PathBuf,
    /// The daemon's session token file, which no provider process may read.
    pub(crate) session_token_path: PathBuf,
    /// The one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The one database writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// Where each damaged session's log stops being readable, which no binding's cursor reads past.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// Binds a message's attachments to the artifact store's copies.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// The daemon's git, which the staged reviews' worktrees are made with.
    pub(crate) git: GitRunner,
    /// The login shell's environment captured at the start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// The program's one scheduler.
    pub(crate) scheduler: Arc<Scheduler>,
    /// Reads where a command channel's party runs.
    pub(crate) caller_processes: Arc<dyn CallerProcessReader>,
    /// The readers of the record of each provider's builds: the attention projection, which lists
    /// them.
    pub(crate) build_record_readers: Arc<dyn BuildRecordReaders>,
    /// The daemon's record of its own children, opened and swept before the providers are built.
    pub(crate) child_records: Arc<dyn DaemonChildRecords>,
}

/// The providers the daemon runs: their registry, the ports their drivers read, the capability
/// refresh and the provider services the daemon holds a connection to.
pub(crate) struct Providers {
    /// Every driver, in the table's order.
    pub(crate) registry: Arc<ProviderRegistry>,
    /// The ports every driver reads, registered once their owners exist.
    pub(crate) ports: Arc<DriverPorts>,
    /// Reads every driver's capabilities again when asked.
    pub(crate) refresher: Arc<CapabilityRefresher>,
    /// Stores each provider's capability reading and rebuilds the stored one at the start.
    pub(crate) capabilities: Arc<DriverCapabilitiesWriter>,
    /// The refresh's pass task, which the stop ends.
    pub(crate) refreshing: CapabilityRefreshing,
    /// The processes serving the provider services the daemon holds a connection to, which the
    /// caller check refuses descendants of.
    pub(crate) provider_services: Arc<ProviderServiceProcesses>,
    /// Each posture's curated credential list, which the run engine and the permission check
    /// read too.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The epoch cursors of the open runtime bindings, which the inbound dispatch attributes on.
    pub(crate) epochs: Arc<Mutex<ExecutionEpochs>>,
    /// The cursors of each run's binding over the one store of runtime bindings, through which
    /// every driver writes its bindings, so an account a driver moves a binding onto is the one its
    /// cursor answers for.
    pub(crate) binding_cursors: Arc<RunBindingCursors>,
    /// Which provider process runs each session, which every driver records at spawn and exit
    /// and the run queue reads.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The names every provider sets on its processes, which no environment row may set, for the
    /// terminals' shells too.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// Every provider's background work, which the permission check refuses too.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The staged reviews' worktrees, whose leftovers the start sweeps before the socket binds.
    staged_changes: StagedChangesWorktrees,
}

/// Builds the driver of every provider in `registrations`, in its order, over the one bundle of
/// shared services, with every port unregistered, and starts the capability refresh over them, no
/// pass asked yet. Builds start no process and do no I/O; called inside the daemon's runtime,
/// which the refresh's task runs on.
pub(crate) fn build_providers(
    registrations: &[ProviderRegistration],
    start: ProviderStart,
) -> Providers {
    let ports = Arc::new(DriverPorts::new());
    let descriptors: Vec<&'static ProviderDescriptor> = registrations
        .iter()
        .map(|registration| registration.descriptor)
        .collect();
    let reserved_names = Arc::new(ReservedEnvironmentNames::of_providers(&descriptors));
    let background_work = Arc::new(BackgroundWorkForms::of_providers(&descriptors));
    let processes = Arc::new(ProviderProcessRegistry::default());
    let provider_services = Arc::new(ProviderServiceProcesses::default());
    let staged_changes = StagedChangesWorktrees::new(&start.worktrees_folder, start.git);
    let execution_postures = Arc::new(ExecutionPostureService::new(
        &start.home_folder,
        start.session_token_path,
    ));
    let runtime_bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&start.reads),
        Arc::clone(&start.writer),
    ));
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        MAX_ASSOCIATIONS_PER_BINDING,
    )));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&start.reads),
        start.read_damaged_from_sequence,
        Arc::clone(&runtime_bindings),
        Arc::clone(&epochs),
    ));
    let services = DriverServices {
        spawner: start.spawner.clone(),
        data_folder: start.data_folder,
        home_folder: start.home_folder.clone(),
        pool: Arc::clone(&start.reads),
        attachments: start.attachments,
        staged_changes: staged_changes.clone(),
        execution_postures: Arc::clone(&execution_postures),
        base_environment: start.base_environment,
        reserved_names: Arc::clone(&reserved_names),
        command_search: Arc::new(ProviderCommandSearch::new(start.spawner.clone())),
        pending_compactions: PendingCompactionRegistry::default(),
        processes: Arc::clone(&processes),
        child_records: start.child_records,
        provider_services: Arc::clone(&provider_services),
        runtime_bindings: Arc::clone(&binding_cursors) as _,
        shell_lines: start.shell_lines,
        background_work: Arc::clone(&background_work),
        scheduler: start.scheduler,
        dispatches_hook_mode: dispatches_hook_mode(),
        caller_processes: start.caller_processes,
        input_waits: Arc::new(SystemInputWaitReader {
            spawner: start.spawner,
        }),
        ports: Arc::clone(&ports),
    };
    let registry = Arc::new(ProviderRegistry::register_from(registrations, &services));
    // A recorded build's write wakes the attention projection's followers, which list it.
    let capabilities = Arc::new(DriverCapabilitiesWriter::new(
        start.reads,
        start.writer,
        start.build_record_readers,
    ));
    let (refresher, refreshing) =
        CapabilityRefresher::start(Arc::clone(&registry), Arc::clone(&capabilities));
    Providers {
        registry,
        ports,
        refresher: Arc::new(refresher),
        capabilities,
        refreshing,
        provider_services,
        execution_postures,
        epochs,
        binding_cursors,
        processes,
        reserved_names,
        background_work,
        staged_changes,
    }
}

/// Records on the registry each provider's last stored capability reading, without asking its
/// driver, so a gated call is answered from it before the first refresh lands; a provider never
/// read, or read with no version, stays refused until then. A stored reading that cannot be
/// rebuilt is reported as a driver diagnostic and its provider's gate stays closed.
pub(crate) async fn hydrate_capabilities(providers: &Providers) {
    for (provider, _) in providers.registry.drivers() {
        let descriptor = providers
            .registry
            .descriptor(provider)
            .expect("a provider the registry lists has a descriptor");
        match providers.capabilities.hydrate(provider, descriptor).await {
            Ok(CapabilityHydration::Hit { result }) => providers
                .registry
                .record_capabilities(provider, result.capabilities)
                .expect("a provider the registry lists has an entry"),
            Ok(
                CapabilityHydration::NeverWritten {} | CapabilityHydration::CliVersionMissing {},
            ) => {}
            Err(error) => emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: provider.clone(),
                provider_account_id: None,
                kind: DriverDiagnosticKind::StoredCapabilitiesUnreadable,
                raw_wire_type: None,
                disposition_reason: "stored capability reading could not be rebuilt; gated calls \
                                     wait for the first refresh"
                    .to_owned(),
                details: Map::from_iter([(
                    "message".to_owned(),
                    Value::from(describe_error(&error)),
                )]),
            }),
        }
    }
}

/// The services behind the drivers' ports, each built after the drivers.
pub(crate) struct DriverPortOwners {
    /// The reads of the accounts a provider runs on.
    pub(crate) provider_accounts: Arc<dyn ProviderAccountReader>,
    /// The account registry, which the drivers' account legs read and write.
    pub(crate) provider_account_registry: Arc<ProviderAccountRegistry>,
    /// The run engine.
    pub(crate) run_engine: Arc<RunEngine>,
    /// The run engine's dispatch of what a provider delivers.
    pub(crate) inbound_dispatch: Arc<RunInboundDispatch>,
    /// The run queue's admission, which opens the binding of a turn the daemon starts.
    pub(crate) queue_admission: Arc<QueueAdmission>,
    /// The run queue's delivery, which hears of each message a provider took, refused or gave
    /// back, and holds the messages waiting for paused runs.
    pub(crate) queue_delivery: QueueDelivery,
    /// The run queue's intake of a session's provider process that ended.
    pub(crate) process_gone: Arc<dyn ProcessGoneListener>,
    /// The run queue's intake of a held lead's continue its provider did not carry.
    pub(crate) continue_given_back: Arc<dyn ContinueGivenBackListener>,
    /// The approval pipeline's permission asks.
    pub(crate) permission_asks: Arc<PermissionAsks>,
    /// The questions card's service.
    pub(crate) questions: Arc<QuestionsService>,
    /// The tool servers' client, which reads their prompts for the `/` list.
    pub(crate) server_prompts: Arc<dyn ServerPromptPort>,
    /// The plan record's service.
    pub(crate) plans: Arc<PlansService>,
    /// The approval pipeline's reviewer blocks.
    pub(crate) reviewer_denials: Arc<ReviewerDenials>,
    /// The database writer, which records the advisor a provider resolved for a session and which
    /// the drivers store their measured limits through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The rules in force on each session.
    pub(crate) approval_rules: Arc<ApprovalRules>,
    /// The places the daemon runs sessions in.
    pub(crate) session_places: Arc<[SessionPlace]>,
    /// The pause and continue of runs.
    pub(crate) run_pauses: Arc<RunPauseControl>,
    /// The usage record, which meters each provider reading and stops a run at its token limit.
    pub(crate) usage: Arc<UsageRecord>,
    /// Every session's running commands, which each driver reports its agent's commands to.
    pub(crate) running_commands: Arc<RunningCommandSets>,
    /// Each run's latest turn readings.
    pub(crate) turn_readings: Arc<TurnReadings>,
    /// Each session's latest context reading.
    pub(crate) context_readings: Arc<ContextReadings>,
    /// The status line of each tool call running in the background.
    pub(crate) tool_call_statuses: Arc<ToolCallStatuses>,
    /// The session logs' tool calls held in the background, which a resume rebuilds.
    pub(crate) held_tool_calls: Arc<StoredHeldToolCalls>,
    /// The session's agent tree, which the drivers' hooks look a named helper up in.
    pub(crate) agent_tree_lookup: Arc<StoredAgentTreeLookup>,
    /// The idle sleep, which wakes a sleeping session for a message.
    pub(crate) idle_sleep: Arc<SessionIdleSleep>,
    /// The stored resume of a sleeping session a driver holds nothing for.
    pub(crate) session_resumes: Arc<StoredSessionResumes>,
    /// Each session's provider session, which follows a level or mode its provider reported.
    pub(crate) provider_sessions: Arc<ProviderSessions>,
    /// The record of each session a driver moves onto another account outside a switch.
    pub(crate) session_account_moves: Arc<dyn SessionAccountMoveRecorder>,
    /// The one lock on account homes, which a driver's renewal in an account's home holds.
    pub(crate) account_home_lock: Arc<AccountHomeLock>,
}

/// The places the daemon runs sessions in: this computer's own system alone, its login shell's
/// environment `base_environment` and the current user's id.
pub(crate) fn native_session_places(base_environment: &[(String, String)]) -> Arc<[SessionPlace]> {
    Arc::from([SessionPlace {
        place: None,
        login_shell: base_environment.to_vec(),
        user_id: current_user_id(),
    }])
}

/// Registers each port whose owner is built, once, the accounts reader first and then the run
/// engine, its dispatch and the queue's turn bindings, so they stand before any driver call. Fails
/// when a port is registered already, which only a second call does.
pub(crate) fn register_driver_ports(
    ports: &DriverPorts,
    owners: DriverPortOwners,
) -> Result<(), PortRegistrationError> {
    ports.provider_accounts.register(owners.provider_accounts)?;
    ports
        .provider_account_registry
        .register(owners.provider_account_registry)?;
    ports.run_engine.register(owners.run_engine)?;
    ports.inbound_dispatch.register(owners.inbound_dispatch)?;
    ports
        .daemon_turn_bindings
        .register(owners.queue_admission)?;
    let queue_delivery = Arc::new(owners.queue_delivery);
    ports
        .message_taken
        .register(Arc::clone(&queue_delivery) as _)?;
    ports
        .message_refused
        .register(Arc::clone(&queue_delivery) as _)?;
    ports
        .message_given_back
        .register(Arc::clone(&queue_delivery) as _)?;
    ports.continued_messages.register(queue_delivery)?;
    ports.process_gone.register(owners.process_gone)?;
    ports
        .continue_given_back
        .register(owners.continue_given_back)?;
    ports.permission_asks.register(owners.permission_asks)?;
    ports.questions.register(owners.questions)?;
    ports.server_prompts.register(owners.server_prompts)?;
    ports.plans.register(owners.plans)?;
    ports.reviewer_denials.register(owners.reviewer_denials)?;
    ports.usage.register(owners.usage)?;
    ports.command_output.register(owners.running_commands)?;
    ports.turn_readings.register(owners.turn_readings)?;
    ports.context_readings.register(owners.context_readings)?;
    ports
        .tool_call_statuses
        .register(owners.tool_call_statuses)?;
    ports.held_tool_calls.register(owners.held_tool_calls)?;
    ports.agent_tree_lookup.register(owners.agent_tree_lookup)?;
    ports.session_wakes.register(owners.idle_sleep)?;
    ports.session_resumes.register(owners.session_resumes)?;
    ports.database_writer.register(Arc::clone(&owners.writer))?;
    ports
        .session_advisors
        .register(Arc::new(ConsoleStateAdvisors(owners.writer)))?;
    ports.session_rules.register(owners.approval_rules)?;
    ports.session_places.register(owners.session_places)?;
    ports
        .session_level_followers
        .register(Arc::new(WeakLevelFollower(Arc::downgrade(
            &owners.provider_sessions,
        ))))?;
    ports
        .session_account_moves
        .register(owners.session_account_moves)?;
    ports.account_home_lock.register(owners.account_home_lock)?;
    ports.run_pauses.register(owners.run_pauses)
}

/// The provider sessions as the drivers' level follower, held weakly: they hold the registry whose
/// drivers hold this port, so a strong hold would keep both alive for good.
struct WeakLevelFollower(Weak<ProviderSessions>);

impl SessionLevelFollower for WeakLevelFollower {
    /// Follows the report through the provider sessions; fails once they are gone, as while the
    /// daemon stops.
    fn follow_reported_level(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let sessions = self.0.upgrade();
        async move {
            let sessions = sessions.ok_or("the provider sessions are gone")?;
            SessionLevelFollower::follow_reported_level(sessions.as_ref(), session_id).await
        }
        .boxed()
    }
}

/// Why no session's inbox addresses can be composed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionInboxAddressesError {
    /// No registered driver's sessions answer an inbox.
    #[error("no registered provider's sessions answer an inbox")]
    NoAddresser,
    /// A place the daemon runs sessions in is not one this computer's system holds.
    #[error(transparent)]
    ForeignPlace(#[from] ForeignPlaceError),
}

/// The inbox addresses of every session, answered by the first driver in the table's order whose
/// sessions answer an inbox, in each of `session_places`; this computer has no WSL 2 distribution.
/// Fails when no driver answers one, or a place is foreign to this computer's system.
#[expect(
    dead_code,
    reason = "the daemon's start builds session.read's addresses \
              through it"
)]
pub(crate) fn compose_session_inbox_addresses(
    registry: &ProviderRegistry,
    session_places: &[SessionPlace],
) -> Result<SessionInboxAddresses, SessionInboxAddressesError> {
    let addresser = registry
        .drivers()
        .find_map(|(_, driver)| driver.session_inbox_addresser())
        .ok_or(SessionInboxAddressesError::NoAddresser)?;
    let installed_places = session_places
        .iter()
        .map(|session_place| session_place.place.clone())
        .collect();
    Ok(SessionInboxAddresses::new(
        PathRules::NATIVE,
        installed_places,
        false,
        addresser,
    )?)
}

/// Removes the staged reviews' worktrees a stopped daemon left, before any call can open one, each
/// failure logged.
pub(crate) async fn sweep_left_staged_worktrees(providers: &Providers) {
    for failure in providers.staged_changes.sweep_left_worktrees().await {
        tracing::warn!(
            error = &failure as &(dyn std::error::Error + 'static),
            "a staged-review worktree a previous run left was not removed"
        );
    }
}

/// Removes the folders of MCP sign-ins a stopped daemon left, each driver its own, before any
/// call can start a sign-in, each failure logged.
pub(crate) async fn sweep_left_sign_in_folders(providers: &Providers) {
    for (provider, driver) in providers.registry.drivers() {
        if let Err(error) = driver.remove_left_sign_in_folders().await {
            tracing::warn!(
                provider = provider.as_str(),
                error = &error as &(dyn std::error::Error + 'static),
                "the MCP sign-in folders a previous run left were not removed"
            );
        }
    }
}

/// Removes the settings files a stopped daemon's provider processes left, each driver its own,
/// before any call can start a process, each failure logged; the next start's sweep takes what
/// stays.
pub(crate) async fn sweep_left_settings_files(providers: &Providers) {
    for (provider, driver) in providers.registry.drivers() {
        if let Err(error) = driver.remove_left_settings_files().await {
            tracing::warn!(
                provider = provider.as_str(),
                error = &error as &(dyn std::error::Error + 'static),
                "the provider settings files a previous run left were not removed"
            );
        }
    }
}

/// The providers' first capability reads running on their own task, which the start waits for
/// before the run queue's recovery and the stop ends before the drivers.
pub(crate) struct ProvidersRegistration {
    /// The task, until it is seen to end; dropped, it ends the task.
    task: Option<AbortOnDropHandle<()>>,
}

/// Why the providers' registration did not end cleanly at the stop.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProvidersRegistrationStopFailure {
    /// It ran past what was left of the drain bound, so it was ended where it stood.
    #[error("the providers' registration did not end within {0:?} and was ended")]
    Aborted(Duration),
    /// Its task panicked.
    #[error("the providers' registration ended abnormally")]
    Ended(#[source] JoinError),
}

impl ProvidersRegistration {
    /// Waits until every driver's first read landed, failed or missed its deadline; at once when it
    /// ended already. Fails when its task panicked.
    pub(crate) async fn finished(&mut self) -> Result<(), JoinError> {
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        let ended = task.await;
        self.task = None;
        ended
    }

    /// Lets the registration end within `remaining`, else ends it where it stands, so no read it
    /// started outlives the stop; called after the capability refresh stopped and before the
    /// drivers shut down. Fails as [`ProvidersRegistrationStopFailure`] says.
    pub(crate) async fn stop(
        mut self,
        remaining: Duration,
    ) -> Result<(), ProvidersRegistrationStopFailure> {
        let Some(mut task) = self.task.take() else {
            return Ok(());
        };
        if let Ok(ended) = tokio::time::timeout(remaining, &mut task).await {
            return ended.map_err(ProvidersRegistrationStopFailure::Ended);
        }
        task.abort();
        match task.await {
            Err(error) if error.is_cancelled() => {
                Err(ProvidersRegistrationStopFailure::Aborted(remaining))
            }
            ended => ended.map_err(ProvidersRegistrationStopFailure::Ended),
        }
    }
}

/// Starts the providers' first capability reads on their own task, not awaited: once
/// `index_opened` settles, every driver's capabilities are read, declared and recorded at once. It
/// ends once every read landed, failed or missed its deadline, or once the refresh stopped before
/// the reads; a failure is logged, never returned. Dropping the handle ends it.
pub(crate) fn register_providers(
    providers: &Providers,
    index_opened: impl Future<Output = ()> + Send + 'static,
) -> ProvidersRegistration {
    let refresher = Arc::clone(&providers.refresher);
    let task = tokio::spawn(async move {
        index_opened.await;
        refresher.refresh_now().await;
    });
    ProvidersRegistration {
        task: Some(AbortOnDropHandle::new(task)),
    }
}

/// Ends every driver's work for `intent`, all at once, each by the one deadline `remaining` from
/// now.
pub(crate) async fn shut_down_drivers(
    registry: &ProviderRegistry,
    intent: DaemonStopIntent,
    remaining: Duration,
) {
    let deadline = tokio::time::Instant::now() + remaining;
    futures::future::join_all(
        registry
            .drivers()
            .map(|(_, driver)| driver.shutdown(intent, deadline)),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::params_and_results::{
        DriverCliVersionReport, GetCapabilitiesResult,
    };
    use sidekicks_provider::driver::test_registry::registrations_of_first_providers;

    use super::hydrate_capabilities;
    use super::test_start::TestStart;

    // A gated call the stored reading allows passes at a cold start, before any refresh pass has
    // read the driver. Killed by leaving the gate unseeded, which refuses it until a pass lands.
    #[tokio::test]
    async fn a_cold_start_answers_a_gated_call_from_the_stored_reading() {
        let start = TestStart::new();
        let providers = start
            .build(&registrations_of_first_providers(vec![Arc::new(
                MockProviderDriver::new(),
            )]))
            .await;
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
        let stored = GetCapabilitiesResult {
            capabilities: DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    flag == DriverCapabilityFlag::ContextCompaction
                }),
                contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a version"),
            },
            tools: Vec::new(),
            cli_version: DriverCliVersionReport {
                raw_version: "2.0.0".to_owned(),
                parsed_version: Some("2.0.0".to_owned()),
            },
            detection_source: None,
            output_speed_levels: None,
        };
        providers
            .capabilities
            .declare(&provider, &stored)
            .await
            .expect("an earlier run stored the reading");
        let before_seed = providers
            .registry
            .check_capability(&provider, DriverCapabilityFlag::ContextCompaction);

        hydrate_capabilities(&providers).await;

        assert!(before_seed.is_err());
        providers
            .registry
            .check_capability(&provider, DriverCapabilityFlag::ContextCompaction)
            .expect("the stored reading allows the call");
        assert!(
            providers
                .registry
                .check_capability(&provider, DriverCapabilityFlag::Steer)
                .is_err()
        );
    }
}
