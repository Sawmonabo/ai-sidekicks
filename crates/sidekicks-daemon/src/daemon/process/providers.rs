//! The providers at the daemon's start: every driver built once from the one bundle of shared
//! services, the capability refresh over them, the ports the drivers read registered once the
//! services behind them exist, and the drivers' first capability reads, which a provider with a
//! lasting service answers by connecting to it.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_platforms::{PathRules, Spawner};
use tokio::task::JoinHandle;

use crate::approvals::permission_asks::PermissionAsks;
use crate::approvals::reviewer_denials::ReviewerDenials;
use crate::approvals::rules::ApprovalRules;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::DatabaseWriter;
use crate::git::process::GitRunner;
use crate::git::worktree::naming::worktrees_folder;
use crate::git::worktree::staged_changes::StagedChangesWorktrees;
use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::plans::service::PlansService;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::callback_tools::host::CallbackToolHost;
use crate::provider::capability::refresh::{CapabilityRefresher, CapabilityRefreshing};
use crate::provider::command_search::ProviderCommandSearch;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::attachments::AttachmentResolver;
use crate::provider::driver::capabilities::writer::DriverCapabilitiesWriter;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::ports::{DriverPorts, ProcessGoneListener, SessionPlace};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::{DriverServices, ProviderDescriptor, ProviderRegistration};
use crate::provider::port::registration::PortRegistrationError;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::runtime_binding::store::RuntimeBindingStore;
use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::questions::service::QuestionsService;
use crate::queue::admission::QueueAdmission;
use crate::queue::delivery::QueueDelivery;
use crate::session::addresses::{ForeignPlaceError, SessionInboxAddresses};
use crate::session::run::engine::RunEngine;
use crate::session::run::inbound::RunInboundDispatch;
use crate::session::run::pause::RunPauseControl;

/// What the providers' build takes from the steps before it.
pub(crate) struct ProviderStart {
    /// The one thread every child process is spawned from.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's session token file, which no provider process may read.
    pub(crate) session_token_path: PathBuf,
    /// The one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The one database writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// Binds a message's attachments to the artifact store's copies.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// The daemon's git, which the staged reviews' worktrees are made with.
    pub(crate) git: GitRunner,
    /// The login shell's environment captured at the start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
}

/// The providers the daemon runs: their registry, the ports their drivers read, the capability
/// refresh and the provider services the daemon holds a connection to.
#[expect(
    dead_code,
    reason = "the daemon's start and stop, which the composition wires, read the providers"
)]
pub(crate) struct Providers {
    /// Every driver, in the table's order.
    pub(crate) registry: Arc<ProviderRegistry>,
    /// The ports every driver reads, registered once their owners exist.
    pub(crate) ports: Arc<DriverPorts>,
    /// Reads every driver's capabilities again when asked.
    pub(crate) refresher: Arc<CapabilityRefresher>,
    /// The refresh's pass task, which the stop ends.
    pub(crate) refreshing: CapabilityRefreshing,
    /// The processes serving the provider services the daemon holds a connection to, which the
    /// caller check refuses descendants of.
    pub(crate) provider_services: Arc<ProviderServiceProcesses>,
    /// Each posture's curated credential list, which the run engine and the permission check
    /// read too.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The one store of runtime bindings, which the run queue and the binding cursors write too.
    pub(crate) runtime_bindings: Arc<RuntimeBindingStore>,
    /// Which provider process runs each session, which every driver records at spawn and exit
    /// and the run queue reads.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The names every provider sets on its processes, which no environment row may set, for the
    /// terminals' shells too.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// The staged reviews' worktrees, whose leftovers the registration sweeps first.
    staged_changes: StagedChangesWorktrees,
}

/// Builds the driver of every provider in `registrations`, in its order, over the one bundle of
/// shared services, with every port unregistered, and starts the capability refresh over them, no
/// pass asked yet. Builds start no process and do no I/O; called inside the daemon's runtime,
/// which the refresh's task runs on.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which the composition wires, builds the providers through it"
    )
)]
pub(crate) fn build_providers(
    registrations: &[ProviderRegistration],
    start: ProviderStart,
) -> Providers {
    let ports = Arc::new(DriverPorts::new());
    let descriptors: Vec<&ProviderDescriptor> = registrations
        .iter()
        .map(|registration| registration.descriptor)
        .collect();
    let reserved_names = Arc::new(ReservedEnvironmentNames::of_providers(&descriptors));
    let processes = Arc::new(ProviderProcessRegistry::default());
    let provider_services = Arc::new(ProviderServiceProcesses::default());
    let staged_changes =
        StagedChangesWorktrees::new(&worktrees_folder(&start.home_folder), start.git);
    let execution_postures = Arc::new(ExecutionPostureService::new(
        &start.home_folder,
        start.session_token_path,
    ));
    let runtime_bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&start.reads),
        Arc::clone(&start.writer),
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
        command_search: Arc::new(ProviderCommandSearch::new(start.spawner)),
        pending_compactions: PendingCompactionRegistry::default(),
        processes: Arc::clone(&processes),
        provider_services: Arc::clone(&provider_services),
        runtime_bindings: Arc::clone(&runtime_bindings) as _,
        shell_lines: start.shell_lines,
        ports: Arc::clone(&ports),
    };
    let registry = Arc::new(ProviderRegistry::register_from(registrations, &services));
    let (refresher, refreshing) = CapabilityRefresher::start(
        Arc::clone(&registry),
        Arc::new(DriverCapabilitiesWriter::new(start.reads, start.writer)),
    );
    Providers {
        registry,
        ports,
        refresher: Arc::new(refresher),
        refreshing,
        provider_services,
        execution_postures,
        runtime_bindings,
        processes,
        reserved_names,
        staged_changes,
    }
}

/// The services behind the drivers' ports, each built after the drivers.
pub(crate) struct DriverPortOwners {
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
    /// The approval pipeline's permission asks.
    pub(crate) permission_asks: Arc<PermissionAsks>,
    /// The questions card's service.
    pub(crate) questions: Arc<QuestionsService>,
    /// The plan record's service.
    pub(crate) plans: Arc<PlansService>,
    /// The approval pipeline's reviewer blocks.
    pub(crate) reviewer_denials: Arc<ReviewerDenials>,
    /// The database writer, which records the advisor a provider resolved for a session.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The rules in force on each session.
    pub(crate) approval_rules: Arc<ApprovalRules>,
    /// The places the daemon runs sessions in.
    pub(crate) session_places: Arc<[SessionPlace]>,
    /// The one callback-tool dispatcher.
    pub(crate) callback_tool_host: Arc<CallbackToolHost>,
    /// The pause and continue of runs.
    pub(crate) run_pauses: Arc<RunPauseControl>,
}

/// Registers each port whose owner is built, once, the run engine, its dispatch and the queue's
/// turn bindings first, so they stand before any driver call. Fails when a port is registered
/// already, which only a second call does.
#[expect(
    dead_code,
    reason = "the daemon's start, which the composition wires, registers the ports through it"
)]
pub(crate) fn register_driver_ports(
    ports: &DriverPorts,
    owners: DriverPortOwners,
) -> Result<(), PortRegistrationError> {
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
    ports.permission_asks.register(owners.permission_asks)?;
    ports.questions.register(owners.questions)?;
    ports.plans.register(owners.plans)?;
    ports.reviewer_denials.register(owners.reviewer_denials)?;
    ports.session_advisors.register(owners.writer)?;
    ports.session_rules.register(owners.approval_rules)?;
    ports.session_places.register(owners.session_places)?;
    ports
        .callback_tool_host
        .register(owners.callback_tool_host)?;
    ports.run_pauses.register(owners.run_pauses)
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
    reason = "the daemon's start, which the composition wires, builds session.read's addresses \
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

/// Starts the providers' registration on its own task, not awaited: once `index_opened` settles,
/// the staged reviews' worktrees a stopped daemon left are swept, then every driver's capabilities
/// are read, declared and recorded at once, a provider with a lasting service connecting to it in
/// its read. The handle ends once every read landed, failed or missed its deadline; a failure is
/// logged, never returned.
#[expect(
    dead_code,
    reason = "the daemon's start, which the composition wires, starts the registration through it"
)]
pub(crate) fn register_providers(
    providers: &Providers,
    index_opened: impl Future<Output = ()> + Send + 'static,
) -> JoinHandle<()> {
    let refresher = Arc::clone(&providers.refresher);
    let staged_changes = providers.staged_changes.clone();
    tokio::spawn(async move {
        index_opened.await;
        for failure in staged_changes.sweep_left_worktrees().await {
            tracing::warn!(
                error = &failure as &(dyn std::error::Error + 'static),
                "a staged-review worktree a previous run left was not removed"
            );
        }
        if !refresher.refresh_now().await {
            tracing::warn!("the capability refresh ended before the providers' first reads");
        }
    })
}

/// Ends every driver's work for `intent`, all at once, and answers each driver's failure, in the
/// table's order.
#[expect(
    dead_code,
    reason = "the daemon's stop, which the composition wires, ends the drivers through it"
)]
pub(crate) async fn shut_down_drivers(
    registry: &ProviderRegistry,
    intent: DaemonStopIntent,
) -> Vec<DriverError> {
    futures::future::join_all(
        registry
            .drivers()
            .map(|(_, driver)| driver.shutdown(intent)),
    )
    .await
    .into_iter()
    .filter_map(Result::err)
    .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, LazyLock};

    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_platforms::Spawner;
    use tempfile::TempDir;
    use tokio::runtime::Handle;

    use super::{ProviderStart, Providers, build_providers};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::events::log_service::tests::open_log;
    use crate::git::process::{GitLimits, GitRunner};
    use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
    use crate::provider::driver::contract::MockProviderDriver;
    use crate::provider::driver::test_registry::NothingServed;
    use crate::provider::driver::{PROVIDERS, ProviderRegistration};
    use crate::queue::delivery::{ProviderProcessIdentity, ProviderProcessIds};

    /// The statements the tests' read pool caches.
    const READ_STATEMENT_CAPACITY: usize = 16;

    /// The most line bytes the tests' bound lets the shell-line reader parse at once.
    const SHELL_LINE_LIMIT: usize = 1 << 20;

    /// The provider process the stand-in driver records as spawned.
    const SPAWNED: ProviderProcessIdentity = ProviderProcessIdentity {
        process_id: 7,
        spawn_sequence: 1,
    };

    /// The session the stand-in driver records its process for.
    static SPAWNED_SESSION: LazyLock<SessionId> = LazyLock::new(test_session_id);

    /// The database and the home folder a test's providers are built on.
    struct TestStart {
        database: TestDatabase,
        home: TempDir,
    }

    impl TestStart {
        fn new() -> Self {
            Self {
                database: TestDatabase::new(),
                home: tempfile::tempdir().expect("the test makes a home folder"),
            }
        }

        /// The providers of `registrations`, built as the daemon's start builds them, on this
        /// start's database and home.
        async fn build(&self, registrations: &[ProviderRegistration]) -> Providers {
            let log = open_log(&self.database, None).await;
            let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
            let base_environment: Arc<[(String, String)]> = Arc::from([]);
            build_providers(
                registrations,
                ProviderStart {
                    spawner: spawner.clone(),
                    data_folder: self.home.path().join("data"),
                    home_folder: self.home.path().to_owned(),
                    session_token_path: self.home.path().join("daemon.token"),
                    reads: Arc::new(DatabaseReadPool::new(
                        self.database.path(),
                        READ_STATEMENT_CAPACITY,
                    )),
                    writer: Arc::clone(&log.writer),
                    attachments: Arc::new(NothingServed),
                    git: GitRunner::new(
                        spawner,
                        None,
                        Arc::clone(&base_environment),
                        GitLimits::DAEMON,
                    ),
                    base_environment,
                    shell_lines: Arc::new(ShellLineReadingBound::new(SHELL_LINE_LIMIT)),
                },
            )
        }
    }

    // A process a driver records at its spawn is the one the run queue reads for the session: the
    // drivers and the queue share one registry. Killed by handing the queue a registry of its own,
    // which reads no process for any session.
    #[tokio::test]
    async fn the_run_queue_reads_the_process_a_driver_recorded() {
        let start = TestStart::new();
        let registrations = [ProviderRegistration {
            descriptor: PROVIDERS[0],
            build: |services| {
                services.processes.record(*SPAWNED_SESSION, SPAWNED);
                Arc::new(MockProviderDriver::new())
            },
        }];

        let providers = start.build(&registrations).await;

        let queue_reads: Arc<dyn ProviderProcessIds> = providers.processes;
        assert_eq!(
            queue_reads.process_identity(&SPAWNED_SESSION),
            Some(SPAWNED)
        );
    }
}
