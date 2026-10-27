//! The driver registry other areas' tests build on: the shared services every driver's build
//! takes, the table's first providers answered by stand-in drivers, and a run bound to the first
//! one; the run, session and message ids the drivers' tests mint, and the run queue's intake as a
//! driver tells it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::params;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;
use tokio::sync::Notify;

use crate::background_work::BackgroundWorkForms;
use crate::command_search::ProviderCommandSearch;
use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::attachments::{AttachmentResolver, ProviderAttachment};
use crate::driver::contract::ProviderDriver;
use crate::driver::ports::{
    DriverPorts, MessageGivenBackListener, MessageRefusedListener, MessageTakenListener,
};
use crate::driver::registry::ProviderRegistry;
use crate::driver::{DriverServices, PROVIDERS, ProviderRegistration};
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::runtime_binding::store::RuntimeBindingRebind;
use crate::spawn_environment::ReservedEnvironmentNames;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;

/// The statements a test's read pool caches.
const TEST_POOL_STATEMENT_CAPACITY: usize = 16;

/// The most line bytes the test bound lets the shell-line reader parse at once.
const TEST_SHELL_LINE_LIMIT: usize = 1 << 20;

/// What a test that resolves no attachment, or rebinds no binding, answers: the daemon's part that
/// serves it is not built in that test.
#[derive(Debug, thiserror::Error)]
#[error("the test serves no {0}")]
struct NotServedInTest(&'static str);

/// An attachment resolver and binding rebinder that serve nothing.
pub struct NothingServed;

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

/// The shared services every driver's build takes, with every port unregistered, the spawn
/// contexts among them, no attachment or binding rebind served, the read pool on a database no
/// test opens, every folder under a relative one that no test makes, and a set of held provider
/// services of its own, which a test reads through its field. Called on a tokio runtime, which
/// the spawner thread starts on.
pub fn test_driver_services() -> DriverServices {
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
        runtime_bindings: Arc::new(NothingServed),
        shell_lines: Arc::new(ShellLineReadingBound::new(TEST_SHELL_LINE_LIMIT)),
        background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
        dispatches_hook_mode: false,
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
pub fn registry_of_first_provider(driver: Arc<dyn ProviderDriver>) -> ProviderRegistry {
    registry_of_first_providers(vec![driver])
}

/// A registry holding the table's first providers in its order, one for each of `drivers`, each
/// answered by its driver. Called on a tokio runtime, which the spawner thread is started on.
pub fn registry_of_first_providers(drivers: Vec<Arc<dyn ProviderDriver>>) -> ProviderRegistry {
    let services = test_driver_services();
    ProviderRegistry::register_from(&registrations_of_first_providers(drivers), &services)
}

/// The table's first providers in its order, one for each of `drivers`, each built as its driver;
/// the registry is built from it next, on the same thread.
pub fn registrations_of_first_providers(
    drivers: Vec<Arc<dyn ProviderDriver>>,
) -> Vec<ProviderRegistration> {
    let table = PROVIDERS[..drivers.len()]
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: take_next_driver,
        })
        .collect();
    NEXT_DRIVERS.with_borrow_mut(|next| *next = drivers.into());
    table
}

/// Binds `run_id` in `database` to the table's first provider, as a live runtime binding does, so a
/// test may bind several runs, and answers the binding's id.
pub fn bind_run_to_first_provider(database: &TestDatabase, run_id: RunId) -> RuntimeBindingId {
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

/// A minted run id.
pub fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// A minted session id.
pub fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// A minted id of a queued message.
pub fn new_message_id() -> QueueItemId {
    QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is a queue item id")
}

/// What the run queue's intake was told, telling a waiter at each.
#[derive(Default)]
pub struct RecordedQueue {
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
