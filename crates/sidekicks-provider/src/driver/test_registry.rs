//! The driver registry other areas' tests build on: the shared services every driver's build takes,
//! the table's first providers answered by stand-in drivers, a run bound to the first one, every
//! provider answered by a mock driver, the session inbox addresser the table's own drivers answer,
//! an accounts reader answering the current account and every account's folders it holds, the table
//! with Codex's driver over a scripted service, and the stand-in Codex service a test program runs
//! as itself; the run, session and message ids the drivers' tests mint, and the run queue's intake
//! as a driver tells it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::params;
use secrecy::SecretString;
use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
#[cfg(test)]
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::Spawner;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;
use tokio::runtime::Handle;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::watch;

use crate::account::errors::ProviderAccountRegistryError;
use crate::background_work::BackgroundWorkForms;
use crate::command::waiting_checks::SystemInputWaitReader;
use crate::command_search::ProviderCommandSearch;
use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::attachments::{AttachmentResolver, ProviderAttachment};
use crate::driver::child_records::UnrecordedChildren;
pub use crate::driver::codex::{
    CodexServiceScript, CodexServiceStandIn, CodexServicesBeside, RESUMED_TURN_NAME,
    ScriptedCodexService, serve_as_codex_service_stand_in, stand_in_codex_service,
    start_scripted_codex_service, write_codex_service_script,
};
use crate::driver::contract::{MockProviderDriver, ProviderDriver};
use crate::driver::ports::DriverPorts;
#[cfg(test)]
use crate::driver::ports::{
    ContinueGivenBackListener, MessageGivenBackListener, MessageRefusedListener,
    MessageTakenListener,
};
use crate::driver::registry::ProviderRegistry;
use crate::driver::session_control::SessionToolServer;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, DriverServices, PROVIDER_REGISTRATIONS, PROVIDERS,
    ProviderAccountFolders, ProviderAccountReader, ProviderRegistration, codex,
};
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::store::{RuntimeBindingRebind, compose_spawn_config_text};
use crate::runtime_binding::test_store::{spawn_config_on, test_provider_account_id};
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::ReservedEnvironmentNames;

/// The statements a test's read pool caches.
const TEST_POOL_STATEMENT_CAPACITY: usize = 16;

/// The most line bytes the test bound lets the shell-line reader parse at once.
const TEST_SHELL_LINE_LIMIT: usize = 1 << 20;

/// What a test that resolves no attachment, or writes no binding, answers: the daemon's part that
/// serves it is not built in that test.
#[derive(Debug, thiserror::Error)]
#[error("the test serves no {0}")]
struct NotServedInTest(&'static str);

/// An attachment resolver and binding writer that serve nothing.
pub struct NothingServed;

impl RuntimeBindingWriter for NothingServed {
    fn rebind(
        &self,
        _rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("runtime binding").into()) }.boxed()
    }

    fn keep_recovery_data(
        &self,
        _binding_id: RuntimeBindingId,
        _runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("runtime binding").into()) }.boxed()
    }

    fn move_account(
        &self,
        _binding_id: RuntimeBindingId,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("runtime binding").into()) }.boxed()
    }

    fn replace_tool_servers(
        &self,
        _run_id: RunId,
        _tool_servers: Vec<SessionToolServer>,
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

/// An accounts reader answering every provider's current account as it holds it, every account's
/// sign-in kind as the test sets it, and every account's folders as the one folder it may hold,
/// which is both an account's configuration and credential folder; it reads no credential
/// generation and answers no sealed token.
pub struct TestProviderAccounts {
    current: CurrentProviderAccount,
    folder: Option<PathBuf>,
    sign_in_kind: Mutex<TestSignInKind>,
}

// Every account's sign-in kind as the test set it, or that the test removed the accounts.
#[derive(Clone, Copy)]
enum TestSignInKind {
    Registered(Option<ProviderAuthMode>),
    Removed,
}

impl TestProviderAccounts {
    /// Accounts answering `current`, each registered with no sign-in kind read and no folders.
    pub fn new(current: CurrentProviderAccount) -> Self {
        Self::holding_folder(current, None)
    }

    /// Accounts answering `current`, each registered with no sign-in kind read, whose folders are
    /// both `folder`; `None` answers that no account has folders.
    pub fn holding_folder(current: CurrentProviderAccount, folder: Option<PathBuf>) -> Self {
        Self {
            current,
            folder,
            sign_in_kind: Mutex::new(TestSignInKind::Registered(None)),
        }
    }

    /// Answers `sign_in_kind` as every account's kind from now on.
    pub fn set_sign_in_kind(&self, sign_in_kind: Option<ProviderAuthMode>) {
        *lock(&self.sign_in_kind) = TestSignInKind::Registered(sign_in_kind);
    }

    /// Answers every account's kind read as an account not registered from now on.
    pub fn remove_accounts(&self) {
        *lock(&self.sign_in_kind) = TestSignInKind::Removed;
    }

    /// The folders it answers for every account, `None` where it holds no folder.
    pub fn account_folders(&self) -> Option<ProviderAccountFolders> {
        self.folder.clone().map(|folder| ProviderAccountFolders {
            configuration_folder: folder.clone(),
            credential_store_folder: folder,
        })
    }
}

impl ProviderAccountReader for TestProviderAccounts {
    fn resolve_account_folders(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        let account_folders = self.account_folders().ok_or(AccountFoldersError::NotFound);
        async move { account_folders }.boxed()
    }

    fn current_account(
        &self,
        _provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>> {
        let current = self.current.clone();
        async move { Ok(current) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async { Err(NotServedInTest("credential generation").into()) }.boxed()
    }

    fn read_observed_auth_mode(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
        let sign_in_kind = *lock(&self.sign_in_kind);
        async move {
            match sign_in_kind {
                TestSignInKind::Registered(sign_in_kind) => Ok(sign_in_kind),
                TestSignInKind::Removed => Err(ProviderAccountRegistryError::NotFound.into()),
            }
        }
        .boxed()
    }

    fn read_sealed_token(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }
}

/// A registration holding [`TestProviderAccounts`] answering `current` and no account's folders.
pub fn registered_test_accounts(
    current: CurrentProviderAccount,
) -> Arc<PortRegistration<Arc<dyn ProviderAccountReader>>> {
    let provider_accounts = PortRegistration::new("provider accounts");
    provider_accounts
        .register(Arc::new(TestProviderAccounts::new(current)) as Arc<dyn ProviderAccountReader>)
        .expect("a new registration takes its port");
    Arc::new(provider_accounts)
}

/// The shared services every driver's build takes, with every port unregistered, the spawn
/// contexts among them, no attachment or binding rebind served, no child recorded, the read pool
/// on a database no test opens, every folder under a relative one that no test makes, and a set of
/// held provider services of its own, which a test reads through its field, and a scheduler on a
/// test wall clock set to the present and never moved, so no job a driver sets for an instant
/// falls due. Called on a tokio runtime, which the spawner thread and the scheduler start on.
pub fn test_driver_services() -> DriverServices {
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    let folder = PathBuf::from("driver-services");
    let base_environment: Arc<[(String, String)]> = Arc::from([]);
    let clock = Arc::new(TestWallClock::default());
    clock.set_now(SystemTime::now());
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
        command_search: Arc::new(ProviderCommandSearch::new(spawner.clone())),
        pending_compactions: PendingCompactionRegistry::default(),
        processes: Arc::new(ProviderProcessRegistry::default()),
        child_records: Arc::new(UnrecordedChildren),
        provider_services: Arc::new(ProviderServiceProcesses::default()),
        runtime_bindings: Arc::new(NothingServed),
        shell_lines: Arc::new(ShellLineReadingBound::new(TEST_SHELL_LINE_LIMIT)),
        background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
        scheduler: Arc::new(Scheduler::start(clock, None, watch::channel(0).1)),
        dispatches_hook_mode: false,
        caller_processes: Arc::new(
            ProcessTableReader::for_this_program().expect("this program's reader builds"),
        ),
        input_waits: Arc::new(SystemInputWaitReader { spawner }),
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

/// The table's first provider, the one [`registry_of_first_provider`] registers; unlike the
/// registry's own test provider, the table holds it.
pub fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
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
    let table = PROVIDER_REGISTRATIONS[..drivers.len()]
        .iter()
        .map(|registration| ProviderRegistration {
            build: take_next_driver,
            stop_recorded_services: None,
            ..*registration
        })
        .collect();
    NEXT_DRIVERS.with_borrow_mut(|next| *next = drivers.into());
    table
}

/// Every provider of the table in its order, each built as a mock driver with no expectations, so
/// any call to one fails the test.
pub fn registrations_of_mock_drivers() -> Vec<ProviderRegistration> {
    PROVIDER_REGISTRATIONS
        .iter()
        .map(|registration| ProviderRegistration {
            build: |_| Arc::new(MockProviderDriver::new()),
            stop_recorded_services: None,
            ..*registration
        })
        .collect()
}

/// The table's providers in its order, each built as the table builds it but Codex, whose driver's
/// registry holds `scripted`'s service, every account resolving to its home; the next build from
/// it takes that service, so each daemon start over it is given its service by its own call.
pub fn registrations_over_scripted_codex(
    scripted: &ScriptedCodexService,
) -> &'static [ProviderRegistration] {
    codex::hold_scripted_service(scripted);
    // A start keeps its table for its whole life, and a test makes one or two.
    PROVIDER_REGISTRATIONS
        .iter()
        .map(|registration| ProviderRegistration {
            build: if registration.descriptor.id == codex::DESCRIPTOR.id {
                codex::build_over_scripted_service
            } else {
                registration.build
            },
            ..*registration
        })
        .collect::<Vec<_>>()
        .leak()
}

/// Binds `run_id` in `database` to the table's first provider, as a live runtime binding does, so a
/// test may bind several runs, and answers the binding's id.
pub fn bind_run_to_first_provider(database: &TestDatabase, run_id: RunId) -> RuntimeBindingId {
    let binding_id = mint_uuid_v7().to_string();
    let spawn_config = compose_spawn_config_text(
        &spawn_config_on(test_provider_account_id()),
        &database.path().with_file_name("provider").to_string_lossy(),
    );
    database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, spawn_config, created_at, updated_at)
             VALUES (?1, ?2, ?3, '1.0.0', '1.0.0', ?4, '', '')",
            params![
                binding_id.as_str(),
                run_id.text().as_str(),
                PROVIDERS[0].id,
                spawn_config
            ],
        )
        .expect("the test binds the run to its provider");
    RuntimeBindingId::new(binding_id).expect("a minted UUID is a binding id")
}

/// The session inbox addresser of the first provider in the table whose sessions answer an inbox,
/// its driver built on [`test_driver_services`], which registers no session place, so each POSIX
/// inbox sits in that provider's default folder. Called on a tokio runtime, which the spawner
/// thread starts on.
pub fn session_inbox_addresser() -> Arc<dyn SessionInboxAddresser> {
    ProviderRegistry::register_from(PROVIDER_REGISTRATIONS, &test_driver_services())
        .drivers()
        .find_map(|(_, driver)| driver.session_inbox_addresser())
        .expect("a provider in the table answers a session inbox")
}

/// A minted agent id.
pub fn new_agent_id() -> AgentId {
    AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id")
}

/// A minted run id.
pub fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// A minted session id.
#[cfg(test)]
pub(crate) fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// One fixed session id, for a test that names its session in several places.
#[cfg(test)]
pub(crate) fn fixed_session_id() -> SessionId {
    SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id")
}

/// A minted id of a queued message.
#[cfg(test)]
pub(super) fn new_message_id() -> QueueItemId {
    QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is a queue item id")
}

/// What the run queue's intake was told, telling a waiter at each.
#[cfg(test)]
#[derive(Default)]
pub(super) struct RecordedQueue {
    /// The messages told taken, in order.
    pub(super) taken: Mutex<Vec<String>>,
    /// The messages told refused, each with why, in order.
    pub(super) refused: Mutex<Vec<(String, QueueItemNotDeliveredReason)>>,
    /// The messages told given back, in order.
    pub(super) given_back: Mutex<Vec<String>>,
    /// The leads whose continue was told given back, in order.
    pub(super) continues_given_back: Mutex<Vec<RunId>>,
    /// Tells a waiter at each.
    pub(super) changed: Notify,
}

#[cfg(test)]
impl MessageTakenListener for RecordedQueue {
    fn message_taken(&self, _session_id: SessionId, message_id: &str, _run_id: RunId) {
        lock(&self.taken).push(message_id.to_owned());
        self.changed.notify_one();
    }
}

#[cfg(test)]
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

#[cfg(test)]
impl MessageGivenBackListener for RecordedQueue {
    fn message_given_back(&self, _session_id: SessionId, message_id: &str) {
        lock(&self.given_back).push(message_id.to_owned());
        self.changed.notify_one();
    }
}

#[cfg(test)]
impl ContinueGivenBackListener for RecordedQueue {
    fn continue_given_back(&self, _session_id: SessionId, lead_run_id: RunId) {
        lock(&self.continues_given_back).push(lead_run_id);
        self.changed.notify_one();
    }
}
