//! The `provider.account.*` methods: who reaches them, the gateway's admission before any of them
//! runs; and, over the method sources a test builds, the subscription's notices and the wake
//! helper's install and removal behind an account's wake switch.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::{ExposeSecret as _, SecretString};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, CURRENT_PROTOCOL_VERSION,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    PROVIDER_ACCOUNT_METHOD_DESCRIPTORS, ProviderAccountRegister, ProviderAccountSubscribe,
    ProviderAccountUpdate, ProviderAccountUpdateResponse, ProviderWakeHelperState,
};
use sidekicks_contracts::provider::account::record::{
    ProviderAccountId, ProviderAccountNotification, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::ProviderAccountRegisterResponse;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::caller_process::descent::test_reader::ScriptedReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistry, MethodRegistryBuilder, Reply, Request,
};
use sidekicks_ipc::stream::feed::CreditGate;
use sidekicks_platforms::{
    ParentProcess, ResponsibleProcess, WakeHelperStatus, WallClock, this_process,
};
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::{
    AccountLiveTurns, ProviderAccountObserver, ProviderAccountObserverDeps,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::account::sign_in::{ProviderSignInBroker, SignedInAccountWatcher};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::account::wake_helper::{
    MachineWakeHelper, ScriptedWakeHelper, WakeHelperCall,
};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::account::ProviderTokenStatusLegs;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::driver::{PROVIDERS, ProviderAccountFolders, ProviderAccountReader};
use sidekicks_provider::port::usage_sink::{MeteredUsage, ProviderQuotaWindow, UsageSink};
use sidekicks_provider::usage_delta_accountant::UsageAxisCounts;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;
use tokio::sync::watch;

use super::notifications::ProviderAccountNotifications;
use super::registration::WAKE_HELPER_REMOVED_REASON;
use super::{ProviderAccountMethodSources, register_provider_account_methods};
use crate::daemon::schema::schema_parts;
use crate::orchestration::account_switch::{AccountSwitch, AccountSwitchDeps, SessionLevelMoves};

/// This start's session token.
const SESSION_TOKEN: &str = "the-session-token";

/// The dispatch behind the gate: it records every call that reaches it and serves only the
/// handshake, so a recorded account method is one the gate let through.
struct RecordingDispatch {
    registry: Arc<MethodRegistry>,
    reached: Mutex<Vec<String>>,
}

impl Dispatch for RecordingDispatch {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        self.reached
            .lock()
            .expect("no test thread panics holding the record")
            .push(request.method.clone());
        if request.method == CONNECTION_INITIALIZE_METHOD {
            self.registry.dispatch(request, context)
        } else {
            futures::future::ready(Err(DispatchError::MethodNotFound)).boxed()
        }
    }
}

// The caller is untracked by the system and its parent is the daemon (the test's own process),
// as a command an agent ran is. The real caller check refuses it whether its hello holds the
// session token or none, and every account method on that connection is refused the same, with
// no detail, so no readiness entry and no remedy, before any reaches the dispatch. Killed by an
// admission arm that lets a token through from inside the daemon's tree: the hello with the token
// would then latch and the account methods reach the dispatch.
#[rstest]
#[case::holding_the_session_token(Some(SESSION_TOKEN))]
#[case::without_a_token(None)]
#[tokio::test]
async fn a_daemon_started_caller_reaches_no_provider_account_method(#[case] token: Option<&str>) {
    let check = CallerCheck::new(
        Arc::new(ScriptedReader {
            responsible: ResponsibleProcess::Untracked,
            parent: ParentProcess::Pinned(this_process()),
            is_desktop_client: false,
            was_signature_read: AtomicBool::new(false),
        }) as Arc<dyn CallerProcessReader>,
        Arc::new(HashSet::new),
        Arc::new(ProviderServiceProcesses::default()),
    );
    let negotiator = ProtocolNegotiator::new(SESSION_TOKEN.to_owned(), check.admission_check());
    let mut builder = MethodRegistryBuilder::new();
    negotiator
        .register_handshake(&mut builder)
        .expect("the handshake registers");
    let registry = Arc::new(builder.freeze());
    let recording = Arc::new(RecordingDispatch {
        registry: Arc::clone(&registry),
        reached: Mutex::new(Vec::new()),
    });
    let gate = negotiator.gate(Arc::clone(&recording) as Arc<dyn Dispatch>, registry);
    let caller = || HandlerContext {
        caller_process: Some(this_process()),
        ..context(1)
    };

    let mut hello = json!({ "protocolVersion": CURRENT_PROTOCOL_VERSION });
    if let Some(token) = token {
        hello["sessionToken"] = json!(token);
    }
    let refused = |answer: Result<Reply, DispatchError>| match answer {
        Err(DispatchError::Refused(refusal)) => {
            assert_eq!(refusal.code, RefusalCode::AuthCallerRefused);
            assert!(refusal.detail.is_none());
        }
        Ok(_) => panic!("the call was served"),
        Err(other) => panic!("the call failed otherwise: {other}"),
    };
    refused(
        gate.dispatch(
            request(CONNECTION_INITIALIZE_METHOD, Some(&hello)),
            caller(),
        )
        .await,
    );
    for descriptor in PROVIDER_ACCOUNT_METHOD_DESCRIPTORS.methods {
        refused(
            gate.dispatch(request(descriptor.method, Some(&json!({}))), caller())
                .await,
        );
    }

    assert_eq!(
        *recording
            .reached
            .lock()
            .expect("no test thread panics holding the record"),
        [CONNECTION_INITIALIZE_METHOD]
    );
}

// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 64;

// How long a test waits for a notification before it fails.
const WAIT: Duration = Duration::from_secs(10);

fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

// An in-memory keychain service that keeps every value written.
#[derive(Default)]
struct HeldTokens(Mutex<BTreeMap<String, String>>);

impl SecretKeychain for HeldTokens {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        lock(&self.0).insert(account.to_owned(), value.expose_secret().to_owned());
        async { Ok(()) }.boxed()
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        let held = lock(&self.0).get(account).cloned().map(SecretString::from);
        async move { Ok(held) }.boxed()
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let removed = lock(&self.0).remove(account).is_some();
        async move { Ok(removed) }.boxed()
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        let accounts = lock(&self.0).keys().cloned().collect();
        async move { Ok(accounts) }.boxed()
    }
}

// A provider's status read that accepts every pasted token as an OAuth token.
struct AcceptingStatusRead;

impl ProviderTokenStatusLegs for AcceptingStatusRead {
    fn read_token_status<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>> {
        async { Ok(Some(ProviderAuthMode::OauthToken)) }.boxed()
    }
}

// A usage record no test reads: no provider here has a limits read or a window turn.
struct UnreadUsage;

impl UsageSink for UnreadUsage {
    fn record_metered(
        &self,
        _metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no turn is metered here".into()) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no window is read here".into()) }.boxed()
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no window is read here".into()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async { Err("no thread resumes here".into()) }.boxed()
    }
}

// No session holds a turn or a running process here.
struct NoSessions;

impl AccountLiveTurns for NoSessions {
    fn sessions_with_live_turns(&self, _provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        Vec::new()
    }
}

impl SessionLevelMoves for NoSessions {
    fn change_level(
        &self,
        _session_id: SessionId,
        _level: PermissionLevel,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no session runs here".into()) }.boxed()
    }
}

// The `provider.account.*` methods over a test database, the real registry, token custody,
// observer, broker and switch, a first provider whose status read accepts every token, and the
// test's wake helper.
struct MethodInputs {
    _database: TestDatabase,
    _log: TestLog,
    _data_folder: TempDir,
    accounts: Arc<ProviderAccountRegistry>,
    registry: MethodRegistry,
}

impl MethodInputs {
    async fn new(wake_helper: Arc<ScriptedWakeHelper>) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let data_folder = tempfile::tempdir().expect("the test makes a data folder");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let accounts = Arc::new(ProviderAccountRegistry::new(
            Arc::clone(&reads),
            Arc::clone(&log.writer),
            data_folder.path().to_path_buf(),
        ));
        let keychain: Arc<dyn SecretKeychain> = Arc::new(HeldTokens::default());
        let account_reader: Arc<dyn ProviderAccountReader> = Arc::new(ProviderAccounts::new(
            Arc::clone(&reads),
            Arc::clone(&keychain),
        ));
        let token_custody = Arc::new(ProviderTokenCustody::new(
            Arc::clone(&accounts),
            keychain,
            HashMap::from([(
                first_provider(),
                Arc::new(AcceptingStatusRead) as Arc<dyn ProviderTokenStatusLegs>,
            )]),
        ));
        let clock: Arc<dyn WallClock> = Arc::new(TestWallClock::default());
        let home_lock = Arc::new(AccountHomeLock::default());
        let wake_helper = wake_helper as Arc<dyn MachineWakeHelper>;
        let observer = Arc::new(ProviderAccountObserver::new(ProviderAccountObserverDeps {
            registry: Arc::clone(&accounts),
            account_reader: Arc::clone(&account_reader),
            legs: HashMap::new(),
            window_turn_legs: HashMap::new(),
            token_custody: Arc::clone(&token_custody),
            database_reads: Arc::clone(&reads),
            database_writer: Arc::clone(&log.writer),
            usage: Arc::new(UnreadUsage),
            live_turns: Arc::new(NoSessions),
            home_lock: Arc::clone(&home_lock),
            scheduler: Arc::new(Scheduler::start(
                Arc::clone(&clock),
                None,
                watch::channel(0).1,
            )),
            wall_clock: clock,
            wake_helper: Some(Arc::clone(&wake_helper)),
        }));
        let publisher = Arc::new(ProviderAccountNotifications::new());
        let providers = Arc::new(registry_of_first_provider(Arc::new(
            MockProviderDriver::new(),
        )));
        let account_switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
            accounts: Arc::clone(&accounts),
            account_reader: Arc::clone(&account_reader),
            switch_legs: HashMap::new(),
            providers: Arc::clone(&providers),
            level_moves: Arc::new(NoSessions),
            appender: Arc::new(SessionEventAppender::new(
                Arc::clone(&log.service),
                SESSION_EVENT_VERSION.clone(),
            )),
            reads: Arc::clone(&reads),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None::<i64>),
        }));
        let mut builder = MethodRegistryBuilder::new();
        register_provider_account_methods(
            &mut builder,
            ProviderAccountMethodSources {
                accounts: Arc::clone(&accounts),
                providers,
                sign_in: Arc::new(ProviderSignInBroker::new(
                    Arc::clone(&accounts),
                    HashMap::new(),
                    Arc::clone(&publisher) as _,
                    Arc::clone(&observer) as Arc<dyn SignedInAccountWatcher>,
                )),
                token_custody,
                observer,
                account_reader,
                account_legs: HashMap::new(),
                memory_import_legs: HashMap::new(),
                home_lock,
                live_turns: Arc::new(NoSessions),
                publisher,
                database_reads: reads,
                machine_device_id: DeviceId::new("device".to_owned())
                    .expect("the id is well formed"),
                wake_helper: Some(wake_helper),
                account_switch,
            },
        )
        .expect("the account methods register");
        Self {
            _database: database,
            _log: log,
            _data_folder: data_folder,
            accounts,
            registry: builder.freeze(),
        }
    }

    // Calls `method` with `params` from this machine's device and reads its result as `Answer`.
    async fn call<Answer: DeserializeOwned>(&self, method: &str, params: &Value) -> Answer {
        match self
            .registry
            .dispatch(request(method, Some(params)), context(1))
            .await
        {
            Ok(Reply::Result(result)) => {
                serde_json::from_slice(&result.json).expect("the result reads as its type")
            }
            Ok(Reply::Subscription { .. }) => panic!("{method} answered a subscription"),
            Err(error) => panic!("{method} failed: {error}"),
        }
    }

    // Registers a pasted-token account of the first provider.
    async fn register_token_account(&self) -> ProviderAccountRegisterResponse {
        self.call(
            ProviderAccountRegister::DESCRIPTOR.method,
            &json!({
                "provider": first_provider().as_str(),
                "displayLabel": "Work",
                "billingMode": "subscription",
                "nonInteractiveToken": "a-pasted-token",
            }),
        )
        .await
    }

    // Turns `account_id`'s wake switch to `is_on`.
    async fn switch_wake(
        &self,
        account_id: &ProviderAccountId,
        is_on: bool,
    ) -> ProviderAccountUpdateResponse {
        self.call(
            ProviderAccountUpdate::DESCRIPTOR.method,
            &json!({ "accountId": account_id.as_str(), "wakeForWindowStartEnabled": is_on }),
        )
        .await
    }
}

// A client subscribed before a pasted token is registered reads that account, as the registration
// answered it, on its stream. Killed by the subscription left unregistered, and by a feed that
// reads a broadcast other than the one the methods publish on.
#[tokio::test]
async fn a_subscriber_reads_the_account_a_pasted_token_registered() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let Ok(Reply::Subscription { mut feed, .. }) = inputs
        .registry
        .dispatch(
            request(
                ProviderAccountSubscribe::DESCRIPTOR.method,
                Some(&json!({})),
            ),
            context(2),
        )
        .await
    else {
        panic!("the subscribe answers a subscription");
    };

    let registered = inputs.register_token_account().await;

    let gate = CreditGate::with_credit(1);
    let emission = tokio::time::timeout(WAIT, feed.next(&gate))
        .await
        .expect("a notification comes")
        .expect("the notification reads")
        .expect("the stream goes on");
    let notification: ProviderAccountNotification =
        serde_json::from_slice(&emission.json).expect("the emission reads as its type");
    assert_eq!(
        notification,
        ProviderAccountNotification::AccountChanged {
            account: registered.account
        }
    );
}

// A wake switch turned on whose install the person refuses stays off, in the reply and the stored
// row, and the reply names why. Killed by the refusal dropped, where the switch is stored on with
// no helper to wake the computer.
#[tokio::test]
async fn a_refused_install_leaves_the_wake_switch_off_and_says_why() {
    let helper = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing));
    helper.refuse_installs();
    let inputs = MethodInputs::new(Arc::clone(&helper)).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();

    let updated = inputs.switch_wake(&account_id, true).await;

    assert!(matches!(
        updated.wake_helper,
        Some(ProviderWakeHelperState::NotInstalled { .. })
    ));
    assert_eq!(helper.calls(), [WakeHelperCall::Install]);
    let stored = inputs
        .accounts
        .read(account_id)
        .await
        .expect("the account reads");
    assert!(!stored.wake_for_window_start_enabled);
}

// The last wake switch turned off removes the helper and the reply says why it is gone. Killed by
// the removal's reason missing, where the reply reads the helper as still installed.
#[tokio::test]
async fn the_last_wake_switch_off_removes_the_helper_with_its_reason() {
    let helper = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Installed));
    let inputs = MethodInputs::new(Arc::clone(&helper)).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();
    let turned_on = inputs.switch_wake(&account_id, true).await;
    assert_eq!(
        turned_on.wake_helper,
        Some(ProviderWakeHelperState::Installed {})
    );

    let turned_off = inputs.switch_wake(&account_id, false).await;

    let Some(ProviderWakeHelperState::NotInstalled { reason }) = turned_off.wake_helper else {
        panic!("the helper reads as removed");
    };
    assert_eq!(reason.as_str(), WAKE_HELPER_REMOVED_REASON);
    assert_eq!(helper.calls(), [WakeHelperCall::Uninstall]);
}
