//! The `provider.account.*` methods: who reaches them, the gateway's admission before any of them
//! runs; and, over the method sources a test builds, the subscription's notices and the wake
//! helper's install and removal behind an account's wake switch.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::{ExposeSecret as _, SecretString};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, CURRENT_PROTOCOL_VERSION,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    PROVIDER_ACCOUNT_METHOD_DESCRIPTORS, ProviderAccountCredentialHomeReset,
    ProviderAccountCurrentUpdate, ProviderAccountCurrentUpdateResponse, ProviderAccountRegister,
    ProviderAccountSignIn, ProviderAccountSubscribe, ProviderAccountUpdate,
    ProviderAccountUpdateResponse,
};
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountId, ProviderAccountNotification, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderAccountRegisterResponse, ProviderAccountSignInResponse,
    ProviderSignInArm, ProviderSignInCancelStatus,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::caller_process::descent::test_reader::ScriptedReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, EncodedFeed, HandlerContext, MethodRegistry, MethodRegistryBuilder,
    Reply, Request,
};
use sidekicks_ipc::stream::feed::CreditGate;
use sidekicks_platforms::{
    ParentProcess, ResponsibleProcess, WakeHelperStatus, WallClock, this_process,
};
use sidekicks_provider::account::credential_home::CredentialHome;
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::{
    AccountLiveTurns, ProviderAccountObserver, ProviderAccountObserverDeps,
};
use sidekicks_provider::account::registry::{AccountAdmission, ProviderAccountRegistry};
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::account::sign_in::{
    AccountsInFlight, ProviderSignInBroker, SignedInAccountWatcher,
};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::account::wake_helper::{MachineWakeHelper, ScriptedWakeHelper};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::account::{
    ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs, ProviderSignInObservation,
    ProviderTokenStatusLegs,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::test_registry::{NothingServed, registry_of_first_provider};
use sidekicks_provider::driver::{PROVIDERS, ProviderAccountFolders, ProviderAccountReader};
use sidekicks_provider::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use sidekicks_provider::usage_delta_accountant::UsageAxisCounts;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
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
use super::{ProviderAccountMethodSources, register_provider_account_methods};
use crate::daemon::schema::schema_parts;
use crate::orchestration::account_switch::{AccountSwitch, AccountSwitchDeps, SessionLevelMoves};

mod wake_switch;

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
            parents: HashMap::new(),
            programs: HashMap::new(),
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

// An in-memory keychain service that keeps every value written, until it is told to refuse
// writes.
#[derive(Default)]
struct HeldTokens(Mutex<BTreeMap<String, String>>, AtomicBool);

impl HeldTokens {
    fn refuse_writes(&self) {
        self.1.store(true, Ordering::SeqCst);
    }
}

impl SecretKeychain for HeldTokens {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        if self.1.load(Ordering::SeqCst) {
            let refusal = KeychainRefusal::of_test_keychain(KeychainRefusalCause::Unavailable);
            return async { Err(refusal) }.boxed();
        }
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

    fn hand_resupplied_token<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), DriverError>> {
        async { Ok(()) }.boxed()
    }
}

// A usage record no test reads: no provider here has a limits read or a window turn.
struct UnreadUsage;

impl UsageSink for UnreadUsage {
    fn record_metered(
        &self,
        _metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async { Err("no turn is metered here".into()) }.boxed()
    }

    fn record_cost(
        &self,
        _request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no request is priced here".into()) }.boxed()
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

// A sign-in whose flow starts and never ends, so its account stays signing in.
struct EndlessSignIn;

impl ProviderSignInLegs for EndlessSignIn {
    fn start_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
        _arm: ProviderSignInArm,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        async {
            Ok(ProviderSignInHandle {
                verification_uri: HttpsAddress::new("https://claude.ai/oauth/authorize")
                    .expect("an https address"),
                user_code: None,
                expires_at: None,
                is_browser_opened_by_provider: false,
                code_prompts: futures::stream::pending().boxed(),
                input: Box::new(EndlessSignIn),
                completion: futures::future::pending().boxed(),
            })
        }
        .boxed()
    }

    fn observe_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        unreachable!("the flow never ends")
    }
}

impl ProviderSignInInput for EndlessSignIn {
    fn write_code(
        &self,
        _code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        unreachable!("no code is pasted")
    }

    fn cancel(&self) -> BoxFuture<'_, Result<ProviderSignInCancelStatus, DriverError>> {
        unreachable!("no sign-in is canceled")
    }
}

// The `provider.account.*` methods over a test database, the real registry, token custody,
// observer, broker and switch, a first provider whose status read accepts every token and whose
// sign-in never ends, and the test's wake helper.
struct MethodInputs {
    _database: TestDatabase,
    _log: TestLog,
    data_folder: TempDir,
    accounts: Arc<ProviderAccountRegistry>,
    keychain: Arc<HeldTokens>,
    sign_in: Arc<ProviderSignInBroker>,
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
        let held_tokens = Arc::new(HeldTokens::default());
        let keychain: Arc<dyn SecretKeychain> = Arc::clone(&held_tokens) as _;
        let account_reader: Arc<dyn ProviderAccountReader> = Arc::new(ProviderAccounts::new(
            Arc::clone(&reads),
            Arc::clone(&keychain),
            accounts.observed_auth_modes(),
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
        let accounts_in_flight = Arc::new(AccountsInFlight::default());
        let wake_helper = wake_helper as Arc<dyn MachineWakeHelper>;
        let publisher = Arc::new(ProviderAccountNotifications::new());
        let observer = Arc::new(ProviderAccountObserver::new(ProviderAccountObserverDeps {
            registry: Arc::clone(&accounts),
            account_reader: Arc::clone(&account_reader),
            legs: HashMap::new(),
            window_turn_legs: HashMap::new(),
            token_limits_legs: HashMap::new(),
            token_custody: Arc::clone(&token_custody),
            database_reads: Arc::clone(&reads),
            database_writer: Arc::clone(&log.writer),
            usage: Arc::new(UnreadUsage),
            live_turns: Arc::new(NoSessions),
            accounts_in_flight: Arc::clone(&accounts_in_flight),
            home_lock: Arc::clone(&home_lock),
            scheduler: Arc::new(Scheduler::start(
                Arc::clone(&clock),
                None,
                watch::channel(0).1,
            )),
            wall_clock: clock,
            wake_helper: Some(Arc::clone(&wake_helper)),
            publisher: Arc::clone(&publisher) as _,
            request_held: Arc::new(PortRegistration::new("request held")),
            daemon_started_at: WireInstant::now(),
        }));
        let providers = Arc::new(registry_of_first_provider(Arc::new(
            MockProviderDriver::new(),
        )));
        let account_switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
            accounts: Arc::clone(&accounts),
            accounts_in_flight: Arc::clone(&accounts_in_flight),
            account_reader: Arc::clone(&account_reader),
            switch_legs: HashMap::new(),
            providers: Arc::clone(&providers),
            level_moves: Arc::new(NoSessions),
            bindings: Arc::new(NothingServed),
            appender: Arc::new(SessionEventAppender::new(
                Arc::clone(&log.service),
                SESSION_EVENT_VERSION.clone(),
            )),
            reads: Arc::clone(&reads),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None::<i64>),
        }));
        let sign_in = Arc::new(ProviderSignInBroker::new(
            Arc::clone(&accounts),
            HashMap::from([(
                first_provider(),
                Arc::new(EndlessSignIn) as Arc<dyn ProviderSignInLegs>,
            )]),
            HashMap::new(),
            Arc::clone(&publisher) as _,
            Arc::clone(&observer) as Arc<dyn SignedInAccountWatcher>,
            Arc::clone(&home_lock),
            Arc::clone(&accounts_in_flight),
        ));
        let mut builder = MethodRegistryBuilder::new();
        register_provider_account_methods(
            &mut builder,
            ProviderAccountMethodSources {
                accounts: Arc::clone(&accounts),
                providers,
                sign_in: Arc::clone(&sign_in),
                accounts_in_flight,
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
            data_folder,
            accounts,
            keychain: held_tokens,
            sign_in,
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

    // Subscribes to `provider.account.subscribe` and answers its feed.
    async fn subscribe(&self) -> Box<dyn EncodedFeed> {
        let Ok(Reply::Subscription { feed, .. }) = self
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
        feed
    }
}

// A client subscribed before a pasted token is registered reads that account, as the registration
// answered it, on its stream. Killed by the subscription left unregistered, and by a feed that
// reads a broadcast other than the one the methods publish on.
#[tokio::test]
async fn a_subscriber_reads_the_account_a_pasted_token_registered() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let mut feed = inputs.subscribe().await;

    let registered = inputs.register_token_account().await;

    assert_eq!(
        next_notification(&mut *feed).await,
        ProviderAccountNotification::AccountChanged {
            account: registered.account
        }
    );
}

// The next notification on `feed`, within the wait.
async fn next_notification(feed: &mut dyn EncodedFeed) -> ProviderAccountNotification {
    let gate = CreditGate::with_credit(1);
    let emission = tokio::time::timeout(WAIT, feed.next(&gate))
        .await
        .expect("a notification comes")
        .expect("the notification reads")
        .expect("the stream goes on");
    serde_json::from_slice(&emission.json).expect("the emission reads as its type")
}

// An account registered as the provider's default goes through the switch, which answers the
// account whose mark it moved off, so a subscriber reads that account no longer current before the
// new one. Killed by a registration that moves the mark itself, which leaves the switch's moves and
// the old account's notice out.
#[tokio::test]
async fn an_account_registered_as_default_is_made_current_through_the_switch() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let first = inputs.register_token_account().await.account;
    assert!(first.is_default());
    let mut feed = inputs.subscribe().await;

    let made: ProviderAccountRegisterResponse = inputs
        .call(
            ProviderAccountRegister::DESCRIPTOR.method,
            &json!({
                "provider": first_provider().as_str(),
                "displayLabel": "Home",
                "billingMode": "subscription",
                "nonInteractiveToken": "another-pasted-token",
                "makeDefault": true,
            }),
        )
        .await;

    assert!(made.account.is_default());
    let ProviderAccountNotification::AccountChanged { account: left } =
        next_notification(&mut *feed).await
    else {
        panic!("the first notice is an account change");
    };
    assert_eq!(left.account_id(), first.account_id());
    assert!(!left.is_default());
    assert_eq!(
        next_notification(&mut *feed).await,
        ProviderAccountNotification::AccountChanged {
            account: made.account
        }
    );
}

// A pasted-token registration sent after the daemon's stop is refused before anything is minted,
// so the data folder an erase reads stays empty. Killed by a registration that mints without
// asking whether the sign-in broker has stopped.
#[tokio::test]
async fn a_token_registration_after_the_stop_mints_nothing() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    assert!(inputs.sign_in.stop(WAIT).await, "the broker stops");

    let answer = inputs
        .registry
        .dispatch(
            request(
                ProviderAccountRegister::DESCRIPTOR.method,
                Some(&json!({
                    "provider": first_provider().as_str(),
                    "displayLabel": "Work",
                    "billingMode": "subscription",
                    "nonInteractiveToken": "a-pasted-token",
                })),
            ),
            context(1),
        )
        .await;

    assert!(
        answer.is_err(),
        "the registration after the stop was accepted"
    );
    let left = std::fs::read_dir(inputs.data_folder.path())
        .expect("the data folder reads")
        .count();
    assert_eq!(left, 0, "nothing is minted into the data folder");
}

// A re-supplied token the keychain refuses leaves the account as it was, its name included.
// Killed by a re-supply that writes the new name before the token.
#[tokio::test]
async fn a_refused_token_resupply_leaves_the_name_as_it_was() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();
    inputs.keychain.refuse_writes();

    let answer = inputs
        .registry
        .dispatch(
            request(
                ProviderAccountRegister::DESCRIPTOR.method,
                Some(&json!({
                    "provider": first_provider().as_str(),
                    "accountId": account_id.as_str(),
                    "displayLabel": "Renamed",
                    "billingMode": "subscription",
                    "nonInteractiveToken": "a-fresh-token",
                })),
            ),
            context(1),
        )
        .await;

    assert!(answer.is_err(), "the refused token was accepted");
    let stored = inputs
        .accounts
        .read(account_id)
        .await
        .expect("the account reads");
    assert_eq!(
        stored.display_label.as_ref().map(FreeFormText::as_str),
        Some("Work")
    );
}

// A re-supply to a name another account of the provider holds is refused before its token is
// sealed, so the account keeps the token it had. Killed by a re-supply that replaces the token
// before the rename is refused.
#[tokio::test]
async fn a_resupply_to_a_taken_name_leaves_the_old_token() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    inputs.register_token_account().await;
    let other: ProviderAccountRegisterResponse = inputs
        .call(
            ProviderAccountRegister::DESCRIPTOR.method,
            &json!({
                "provider": first_provider().as_str(),
                "displayLabel": "Home",
                "billingMode": "subscription",
                "nonInteractiveToken": "the-other-pasted-token",
            }),
        )
        .await;

    let answer = inputs
        .registry
        .dispatch(
            request(
                ProviderAccountRegister::DESCRIPTOR.method,
                Some(&json!({
                    "provider": first_provider().as_str(),
                    "accountId": other.account.account_id().as_str(),
                    "displayLabel": "work",
                    "billingMode": "subscription",
                    "nonInteractiveToken": "a-fresh-token",
                })),
            ),
            context(1),
        )
        .await;

    assert!(answer.is_err(), "the taken name was accepted");
    let held: Vec<String> = lock(&inputs.keychain.0).values().cloned().collect();
    assert!(held.iter().any(|token| token == "the-other-pasted-token"));
    assert!(!held.iter().any(|token| token == "a-fresh-token"));
}

// The act a sign-in in flight refuses.
#[derive(Clone, Copy)]
enum ActDuringSignIn {
    Switch,
    Reset,
}

// While a sign-in is in flight on an account, a switch onto it and a reset of its home are each
// refused as a second sign-in is, the mark and the home's generation left as they were. Killed by
// the switch's check or the reset's check dropped, where the call is answered.
#[rstest]
#[case::switch(ActDuringSignIn::Switch)]
#[case::reset(ActDuringSignIn::Reset)]
#[tokio::test]
async fn an_account_signing_in_is_neither_switched_to_nor_reset(#[case] act: ActDuringSignIn) {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let current = inputs.register_token_account().await.account;
    // An account its provider signs in, since one with a pasted token takes no brokered sign-in.
    let minted = inputs
        .accounts
        .mint(first_provider())
        .expect("the account is minted");
    let other = inputs
        .accounts
        .admit(
            &minted,
            &AccountAdmission {
                display_label: None,
                billing_mode: BillingMode::Subscription,
                health: None,
                observed_auth_mode: Some(ProviderAuthMode::OauthSubscription),
            },
        )
        .await
        .expect("the account is admitted");
    let account_id = other.account_id;
    let before = inputs
        .accounts
        .read(account_id.clone())
        .await
        .expect("the account reads");
    let _started: ProviderAccountSignInResponse = inputs
        .call(
            ProviderAccountSignIn::DESCRIPTOR.method,
            &json!({ "accountId": account_id.as_str() }),
        )
        .await;

    let method = match act {
        ActDuringSignIn::Switch => ProviderAccountCurrentUpdate::DESCRIPTOR.method,
        ActDuringSignIn::Reset => ProviderAccountCredentialHomeReset::DESCRIPTOR.method,
    };
    let answer = inputs
        .registry
        .dispatch(
            request(method, Some(&json!({ "accountId": account_id.as_str() }))),
            context(1),
        )
        .await;

    let Err(DispatchError::Refused(refusal)) = answer else {
        panic!("{method} went through during a sign-in");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderAccountSignInInFlight);
    let after = inputs
        .accounts
        .read(account_id)
        .await
        .expect("the account reads");
    assert!(!after.is_default);
    assert_eq!(after.credential_generation, before.credential_generation);
    let still_current = inputs
        .accounts
        .read(current.account_id().clone())
        .await
        .expect("the account reads");
    assert!(still_current.is_default);
}

// Making current the account already current moves no mark, so no change goes out: the next
// notice a subscriber reads is the rename after it. Killed by a switch that publishes the
// account and the one it left whatever the mark did.
#[tokio::test]
async fn making_the_current_account_current_again_publishes_nothing() {
    let inputs =
        MethodInputs::new(Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing))).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();
    let mut feed = inputs.subscribe().await;

    let made: ProviderAccountCurrentUpdateResponse = inputs
        .call(
            ProviderAccountCurrentUpdate::DESCRIPTOR.method,
            &json!({ "accountId": account_id.as_str() }),
        )
        .await;
    let renamed: ProviderAccountUpdateResponse = inputs
        .call(
            ProviderAccountUpdate::DESCRIPTOR.method,
            &json!({ "accountId": account_id.as_str(), "displayLabel": "Renamed" }),
        )
        .await;

    assert!(made.account.is_default());
    assert_eq!(
        next_notification(&mut *feed).await,
        ProviderAccountNotification::AccountChanged {
            account: renamed.account
        }
    );
}
