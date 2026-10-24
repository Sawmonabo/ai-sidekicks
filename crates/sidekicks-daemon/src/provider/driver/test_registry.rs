//! The driver registry other areas' tests build on: the shared services every driver's build
//! takes, the table's first providers answered by stand-in drivers, and a run bound to the first
//! one; the run, session and message ids the drivers' tests mint, the run ends they read back,
//! and the run queue's intake as a driver tells it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;
use tokio::sync::Notify;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::tests::{TestLog, open_log};
use crate::git::process::{GitLimits, GitRunner};
use crate::git::worktree::staged_changes::StagedChangesWorktrees;
use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::mutex_lock::lock;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::command_search::ProviderCommandSearch;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::attachments::{AttachmentResolver, ProviderAttachment};
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::ports::{
    DriverPorts, MessageGivenBackListener, MessageRefusedListener, MessageTakenListener,
};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::{
    DriverServices, PROVIDERS, ProviderAccountFolders, ProviderRegistration, SessionSpawnContext,
    SessionSpawnContextResolver,
};
use crate::provider::port::run_state_publisher::RunStatePublisher;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::provider::runtime_binding::store::RuntimeBindingRebind;
use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::test_engine;
use crate::session::run::epochs::ExecutionEpochs;
use crate::session::run::inbound::RunInboundDispatch;
use crate::session::run::transitions::RUN_TERMINAL_EVENT_TYPES_SQL;

/// The statements a test's read pool caches.
const TEST_POOL_STATEMENT_CAPACITY: usize = 16;

/// The most line bytes the test bound lets the shell-line reader parse at once.
const TEST_SHELL_LINE_LIMIT: usize = 1 << 20;

/// What a test that resolves no spawn context, account folders or attachment, or rebinds no
/// binding, answers: the daemon's part that serves it is not built in that test.
#[derive(Debug, thiserror::Error)]
#[error("the test serves no {0}")]
struct NotServedInTest(&'static str);

/// A spawn-context and account-folder resolver, attachment resolver and binding rebinder that
/// serve nothing.
struct NothingServed;

impl SessionSpawnContextResolver for NothingServed {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("spawn context").into()) }.boxed()
    }

    fn resolve_account_folders(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAccountFolders>, Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("account folders").into()) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("credential generation").into()) }.boxed()
    }
}

impl RuntimeBindingRebinder for NothingServed {
    fn rebind(
        &self,
        _rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("runtime binding").into()) }.boxed()
    }
}

impl AttachmentResolver for NothingServed {
    fn resolve_attachments(
        &self,
        _session_id: SessionId,
        _artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("attachment").into()) }.boxed()
    }
}

/// The shared services every driver's build takes, with every port unregistered, no spawn context,
/// attachment or binding rebind served, the read pool on a database no test opens, every folder
/// under a relative one that no test makes, and a set of held provider services of its own, which
/// a test reads through its field. Called on a tokio runtime, which the spawner thread starts on.
pub(crate) fn test_driver_services() -> DriverServices {
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    let folder = PathBuf::from("driver-services");
    let base_environment: Arc<[(String, String)]> = Arc::from([]);
    DriverServices {
        spawner: spawner.clone(),
        data_folder: folder.join("data"),
        home_folder: folder.join("home"),
        pool: Arc::new(DatabaseReadPool::new(
            folder.join("database.sqlite"),
            TEST_POOL_STATEMENT_CAPACITY,
        )),
        attachments: Arc::new(NothingServed),
        staged_changes: StagedChangesWorktrees::new(
            &folder.join("worktrees"),
            GitRunner::new(
                spawner.clone(),
                None,
                Arc::clone(&base_environment),
                GitLimits::DAEMON,
            ),
        ),
        execution_postures: Arc::new(ExecutionPostureService::new(
            &folder.join("home"),
            folder.join("session-token"),
        )),
        base_environment,
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(PROVIDERS)),
        command_search: Arc::new(ProviderCommandSearch::new(spawner)),
        pending_compactions: PendingCompactionRegistry::default(),
        processes: Arc::new(ProviderProcessRegistry::default()),
        provider_services: Arc::new(ProviderServiceProcesses::default()),
        spawn_contexts: Arc::new(NothingServed),
        runtime_bindings: Arc::new(NothingServed),
        shell_lines: Arc::new(ShellLineReadingBound::new(TEST_SHELL_LINE_LIMIT)),
        ports: Arc::new(DriverPorts::new()),
    }
}

thread_local! {
    // The drivers the next registry this thread builds registers, in the table's order.
    static NEXT_DRIVERS: RefCell<VecDeque<Arc<dyn ProviderDriver>>> =
        const { RefCell::new(VecDeque::new()) };
}

// Hands the registry the next driver the test queued.
fn take_next_driver(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
    NEXT_DRIVERS
        .with_borrow_mut(VecDeque::pop_front)
        .expect("the registry is built right after its drivers are queued")
}

/// A registry holding only the table's first provider, answered by `driver`. Called on a tokio
/// runtime, which the spawner thread is started on.
pub(crate) fn registry_of_first_provider(driver: Arc<dyn ProviderDriver>) -> ProviderRegistry {
    registry_of_first_providers(vec![driver])
}

/// A registry holding the table's first providers in its order, one for each of `drivers`, each
/// answered by its driver. Called on a tokio runtime, which the spawner thread is started on.
pub(crate) fn registry_of_first_providers(
    drivers: Vec<Arc<dyn ProviderDriver>>,
) -> ProviderRegistry {
    let table: Vec<ProviderRegistration> = PROVIDERS[..drivers.len()]
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: take_next_driver,
        })
        .collect();
    let services = test_driver_services();
    NEXT_DRIVERS.with_borrow_mut(|next| *next = drivers.into());
    ProviderRegistry::register_from(&table, &services)
}

/// Binds `run_id` in `database` to the table's first provider, as a live runtime binding does, so a
/// test may bind several runs, and answers the binding's id.
pub(crate) fn bind_run_to_first_provider(
    database: &TestDatabase,
    run_id: RunId,
) -> RuntimeBindingId {
    let binding_id = mint_uuid_v7().to_string();
    database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, created_at, updated_at)
             VALUES (?1, ?2, ?3, '1.0.0', '1.0.0', '', '')",
            params![binding_id.as_str(), run_id.text().as_str(), PROVIDERS[0].id],
        )
        .expect("the test binds the run to its provider");
    RuntimeBindingId::new(binding_id).expect("a minted UUID is a binding id")
}

/// The daemon's own run engine and inbound dispatch on a test's database, which a driver's tests
/// register as the driver's ports, with the dispatch's epochs and the log the engine writes.
pub(crate) struct TestRunPorts {
    /// The engine, every run's folders under the home it was opened on.
    pub(crate) engine: Arc<RunEngine>,
    /// The dispatch over the engine.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
    /// The dispatch's execution epochs.
    pub(crate) epochs: Arc<Mutex<ExecutionEpochs>>,
    /// The event log the engine writes through.
    pub(crate) log: TestLog,
}

impl TestRunPorts {
    /// The engine and dispatch on `database`, every run's folders under `home`, the dispatch
    /// reading its bindings' cursors from `epochs`; no run state stream reads its states.
    pub(crate) async fn open(
        database: &TestDatabase,
        home: &Path,
        epochs: ExecutionEpochs,
    ) -> Self {
        let log = open_log(database, None).await;
        let engine = test_engine(database, Arc::clone(&log.service), home);
        let epochs = Arc::new(Mutex::new(epochs));
        let dispatch = Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            Arc::clone(&epochs),
            Arc::new(UnreadRunStates),
            Arc::clone(&log.service),
        ));
        Self {
            engine,
            dispatch,
            epochs,
            log,
        }
    }

    /// Registers the engine and the dispatch as `ports`' run engine and inbound dispatch.
    pub(crate) fn register_on(&self, ports: &DriverPorts) {
        ports
            .run_engine
            .register(Arc::clone(&self.engine))
            .expect("the run engine registers once");
        ports
            .inbound_dispatch
            .register(Arc::clone(&self.dispatch))
            .expect("the dispatch registers once");
    }
}

/// A run-state stream no one reads.
pub(crate) struct UnreadRunStates;

impl RunStatePublisher for UnreadRunStates {
    fn publish(&self, _hold: RunSafetyBufferingUpdatedPayload) {}
}

/// A minted run id.
pub(crate) fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// A minted session id.
pub(crate) fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// A minted id of a queued message.
pub(crate) fn new_message_id() -> QueueItemId {
    QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is a queue item id")
}

/// Each terminal event of `run_id` in `database`, in order, with whether its end was the daemon's
/// intended close.
pub(crate) fn terminal_events(
    database: &TestDatabase,
    run_id: RunId,
) -> Vec<(String, Option<bool>)> {
    database
        .reader()
        .prepare(&format!(
            "SELECT type, payload FROM session_events WHERE run_id = ?1 AND type IN ({}) \
             ORDER BY sequence",
            *RUN_TERMINAL_EVENT_TYPES_SQL
        ))
        .expect("the test reads the run's events")
        .query_map([run_id.text().as_str()], |row| {
            let payload: String = row.get(1)?;
            let payload: Value = serde_json::from_str(&payload).expect("a stored payload is JSON");
            Ok((row.get(0)?, payload["intendedClose"].as_bool()))
        })
        .expect("the run's events read")
        .collect::<Result<_, _>>()
        .expect("each event reads")
}

/// What the run queue's intake was told, telling a waiter at each.
#[derive(Default)]
pub(crate) struct RecordedQueue {
    /// The messages told taken, in order.
    pub(crate) taken: Mutex<Vec<String>>,
    /// The messages told refused, each with why, in order.
    pub(crate) refused: Mutex<Vec<(String, QueueItemNotDeliveredReason)>>,
    /// The messages told given back, in order.
    pub(crate) given_back: Mutex<Vec<String>>,
    /// Tells a waiter at each.
    pub(crate) changed: Notify,
}

impl MessageTakenListener for RecordedQueue {
    fn message_taken(&self, _session_id: SessionId, message_id: &str, _run_id: RunId) {
        lock(&self.taken).push(message_id.to_owned());
        self.changed.notify_one();
    }
}

impl MessageRefusedListener for RecordedQueue {
    fn message_refused(
        &self,
        _session_id: SessionId,
        message_id: &str,
        reason: QueueItemNotDeliveredReason,
    ) {
        lock(&self.refused).push((message_id.to_owned(), reason));
        self.changed.notify_one();
    }
}

impl MessageGivenBackListener for RecordedQueue {
    fn message_given_back(&self, _session_id: SessionId, message_id: &str) {
        lock(&self.given_back).push(message_id.to_owned());
        self.changed.notify_one();
    }
}
