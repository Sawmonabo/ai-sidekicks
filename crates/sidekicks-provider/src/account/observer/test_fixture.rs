//! What the observer's tests run on: a wall clock they set, scripted limits reads and turns, a
//! usage sink keeping each whole set, and an observer over a test database.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
    ProviderAccountNotification, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{WakeHelperStatus, WallClock, WallClockWait};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use tokio::sync::{Notify, Semaphore, watch};

use super::{
    AccountLiveTurns, AccountReadAnswer, ProviderAccountObserver, ProviderAccountObserverDeps,
    ReadAsker,
};
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{
    AccountAdmission, HealthObservation, PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    ProviderAccountRegistry, RegisteredAccount,
};
use crate::account::resolver::credential_home_folders;
use crate::account::sign_in::{AccountsInFlight, ProviderAccountNotificationPublisher};
use crate::account::token_custody::ProviderTokenCustody;
use crate::account::token_custody::tests::ScriptedKeychain;
use crate::account::wake_helper::{MachineWakeHelper, ScriptedWakeHelper};
use crate::driver::contract::account::{
    ProviderAccountFigures, ProviderObservation, ProviderObserveLegs, ProviderTokenLimitsLegs,
    ProviderWindowTurnLegs, TokenLimitsReading, WindowTurnAnswer, WindowTurnSpend,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::{HeldRequest, RequestHeldListener};
use crate::driver::test_registry::new_session_id;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
};
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::usage_delta_accountant::UsageAxisCounts;

// A wall clock the test sets; nothing here arms its timer.
pub(super) struct TestClock(Mutex<SystemTime>);

impl TestClock {
    pub(super) fn advance(&self, by: Duration) {
        *lock(&self.0) += by;
    }
}

impl WallClock for TestClock {
    fn now(&self) -> SystemTime {
        *lock(&self.0)
    }

    fn arm(&self, _instant: SystemTime) -> std::io::Result<()> {
        Ok(())
    }

    fn disarm(&self) -> std::io::Result<()> {
        Ok(())
    }

    fn wait(&self) -> WallClockWait<'_> {
        Box::pin(std::future::pending())
    }
}

// Limits reads answering the scripted answers in turn, `None` a read that failed; with a gate, each
// read tells `entered` and waits for a permit.
#[derive(Default)]
pub(super) struct ScriptedLegs {
    pub(super) answers: Mutex<VecDeque<Option<ProviderObservation>>>,
    pub(super) read_count: AtomicUsize,
    pub(super) reading_now: AtomicUsize,
    pub(super) most_at_once: AtomicUsize,
    pub(super) gate: Option<(Arc<Semaphore>, Arc<Notify>)>,
}

impl ScriptedLegs {
    pub(super) fn answering(
        answers: impl IntoIterator<Item = Option<ProviderObservation>>,
    ) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().collect()),
            ..Self::default()
        }
    }

    pub(super) fn reads(&self) -> usize {
        self.read_count.load(Ordering::SeqCst)
    }
}

// What each scripted smallest turn spends.
pub(super) fn turn_spend() -> WindowTurnSpend {
    let count = |count| SafeInt::new(count);
    WindowTurnSpend {
        model_id: Some(FreeFormText::new("haiku".to_owned()).expect("a model id")),
        input_tokens: count(395),
        output_tokens: count(51),
        cache_read_tokens: None,
        cache_write_tokens: None,
        reasoning_tokens: None,
    }
}

// Smallest turns that each spend `turn_spend()`, counting the window starts and keeping each
// token a limits read was handed.
#[derive(Default)]
pub(super) struct ScriptedTurns {
    window_starts: AtomicUsize,
    tokens_read: Mutex<Vec<String>>,
}

impl ScriptedTurns {
    pub(super) fn window_starts(&self) -> usize {
        self.window_starts.load(Ordering::SeqCst)
    }

    pub(super) fn tokens_read(&self) -> Vec<String> {
        lock(&self.tokens_read).clone()
    }
}

impl ProviderWindowTurnLegs for ScriptedTurns {
    fn start_window(
        &self,
        _provider_account_id: ProviderAccountId,
        _folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<WindowTurnAnswer, DriverError>> {
        self.window_starts.fetch_add(1, Ordering::SeqCst);
        async { Ok(WindowTurnAnswer::Spent(turn_spend())) }.boxed()
    }
}

impl ProviderTokenLimitsLegs for ScriptedTurns {
    fn read_token_limits<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<TokenLimitsReading, DriverError>> {
        lock(&self.tokens_read).push(token.expose_secret().to_owned());
        async {
            Ok(TokenLimitsReading {
                observation: ProviderObservation::Figures(figures()),
                spend: Some(turn_spend()),
            })
        }
        .boxed()
    }
}

impl ProviderObserveLegs for ScriptedLegs {
    fn observe(
        &self,
        _provider_account_id: ProviderAccountId,
        _folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<ProviderObservation, DriverError>> {
        async move {
            self.read_count.fetch_add(1, Ordering::SeqCst);
            let at_once = self.reading_now.fetch_add(1, Ordering::SeqCst) + 1;
            self.most_at_once.fetch_max(at_once, Ordering::SeqCst);
            if let Some((permits, entered)) = &self.gate {
                entered.notify_one();
                permits
                    .acquire()
                    .await
                    .expect("the gate stays open")
                    .forget();
            }
            self.reading_now.fetch_sub(1, Ordering::SeqCst);
            let answer = lock(&self.answers)
                .pop_front()
                .unwrap_or(Some(ProviderObservation::Figures(figures())));
            answer.ok_or_else(|| DriverError::from(AccountFoldersError::NotFound))
        }
        .boxed()
    }

    fn reads_one_at_a_time(&self) -> bool {
        true
    }

    fn reads_at_turn_end(&self) -> bool {
        true
    }
}

// A read's figures that name one five-hour window and nothing of the account.
pub(super) fn figures() -> ProviderAccountFigures {
    ProviderAccountFigures {
        windows: vec![ProviderQuotaWindow {
            limit_id: "session".to_owned(),
            window_mins: Some(300),
            label: None,
            used_percent: 40.0,
            resets_at: None,
        }],
        ..ProviderAccountFigures::default()
    }
}

// One set of quota windows the observer recorded, with its account.
type RecordedQuotaSet = (ProviderAccountId, Vec<ProviderQuotaWindow>);

// Each set of quota windows the observer recorded: the whole sets a limits read answered, and the
// partial ones a turn named.
#[derive(Default)]
pub(super) struct RecordedQuotaSets {
    whole: Mutex<Vec<RecordedQuotaSet>>,
    partial: Mutex<Vec<RecordedQuotaSet>>,
}

impl RecordedQuotaSets {
    pub(super) fn whole_sets(&self) -> Vec<RecordedQuotaSet> {
        lock(&self.whole).clone()
    }

    pub(super) fn partial_sets(&self) -> Vec<RecordedQuotaSet> {
        lock(&self.partial).clone()
    }
}

impl UsageSink for RecordedQuotaSets {
    fn record_metered(
        &self,
        _metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }

    fn record_cost(
        &self,
        _request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("the recorded whole sets price no request".into()) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.partial).push((provider_account_id, windows));
        async { Ok(()) }.boxed()
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.whole).push((provider_account_id, windows));
        async { Ok(()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async { Ok(UsageAxisCounts::default()) }.boxed()
    }
}

// Each notification the observer published, in order.
#[derive(Default)]
pub(super) struct RecordedNotifications(Mutex<Vec<ProviderAccountNotification>>);

impl RecordedNotifications {
    pub(super) fn published(&self) -> Vec<ProviderAccountNotification> {
        lock(&self.0).clone()
    }
}

impl ProviderAccountNotificationPublisher for RecordedNotifications {
    fn publish(&self, notification: ProviderAccountNotification) {
        lock(&self.0).push(notification);
    }
}

// Each request handed to the repricing, its provider and account.
#[derive(Default)]
pub(super) struct RecordedHeldRequests(Mutex<Vec<(ProviderId, ProviderAccountId)>>);

impl RecordedHeldRequests {
    pub(super) fn handed_over(&self) -> Vec<(ProviderId, ProviderAccountId)> {
        lock(&self.0).clone()
    }
}

impl RequestHeldListener for RecordedHeldRequests {
    fn request_held(
        &self,
        held: HeldRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.0).push((held.key.provider, held.key.account_id));
        async { Ok(()) }.boxed()
    }
}

// Whether a turn reads as live on every account, and a run's end a test has happen once, inside
// the next check that finds a turn live, after that check read it as live.
#[derive(Default)]
pub(super) struct TestLiveTurns {
    pub(super) is_live: AtomicBool,
    pub(super) run_end_during_check: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl AccountLiveTurns for TestLiveTurns {
    fn sessions_with_live_turns(&self, _provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        if !self.is_live.load(Ordering::SeqCst) {
            return Vec::new();
        }
        let run_end = lock(&self.run_end_during_check).take();
        if let Some(run_end) = run_end {
            run_end();
        }
        vec![new_session_id()]
    }
}

// An accounts reader answering each registered account's folders as the daemon's own reader does,
// with no look at whether its home stands.
struct HomeFolders(Arc<ProviderAccountRegistry>);

impl ProviderAccountReader for HomeFolders {
    fn resolve_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        async move {
            let account = self
                .0
                .read(provider_account_id)
                .await
                .map_err(|_unregistered| AccountFoldersError::NotFound)?;
            Ok(credential_home_folders(
                &account.provider,
                &account.credential_home,
            ))
        }
        .boxed()
    }

    fn current_account(
        &self,
        _provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>> {
        async { Err("no current account in the observer's tests".into()) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async { Err("no generation in the observer's tests".into()) }.boxed()
    }

    fn read_observed_auth_mode(
        &self,

        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }

    fn read_sealed_token(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }
}

pub(super) fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

pub(super) fn codex() -> ProviderId {
    ProviderId::new("codex".to_owned()).expect("the Codex provider id")
}

pub(super) struct Fixture {
    pub(super) registry: Arc<ProviderAccountRegistry>,
    pub(super) writer: Arc<DatabaseWriter>,
    pub(super) home_lock: Arc<AccountHomeLock>,
    pub(super) accounts_in_flight: Arc<AccountsInFlight>,
    pub(super) live_turns: Arc<TestLiveTurns>,
    pub(super) clock: Arc<TestClock>,
    pub(super) scheduler: Arc<Scheduler>,
    pub(super) keychain: Arc<ScriptedKeychain>,
    pub(super) legs: Arc<ScriptedLegs>,
    pub(super) turns: HashMap<ProviderId, Arc<ScriptedTurns>>,
    pub(super) usage: Arc<RecordedQuotaSets>,
    pub(super) wakes: Arc<ScriptedWakeHelper>,
    pub(super) notifications: Arc<RecordedNotifications>,
    pub(super) held_requests: Arc<RecordedHeldRequests>,
    pub(super) observer: ProviderAccountObserver,
}

impl Fixture {
    // An observer over `database` reading through `legs`, on `clock`, with scripted turns on
    // Claude Code and Codex.
    pub(super) async fn open(
        database: &TestDatabase,
        data_folder: &Path,
        clock: Arc<TestClock>,
        legs: ScriptedLegs,
    ) -> Self {
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
        ));
        let registry = Arc::new(ProviderAccountRegistry::new(
            Arc::clone(&reads),
            Arc::clone(&writer),
            data_folder.to_owned(),
        ));
        let home_lock = Arc::new(AccountHomeLock::default());
        let accounts_in_flight = Arc::new(AccountsInFlight::default());
        let live_turns = Arc::new(TestLiveTurns::default());
        let scheduler = Arc::new(Scheduler::start(
            Arc::clone(&clock) as Arc<dyn WallClock>,
            None,
            watch::channel(0).1,
        ));
        let keychain = Arc::new(ScriptedKeychain::default());
        let legs = Arc::new(legs);
        let turns: HashMap<ProviderId, Arc<ScriptedTurns>> = [claude(), codex()]
            .into_iter()
            .map(|provider| (provider, Arc::default()))
            .collect();
        let window_turn_legs = turns
            .iter()
            .map(|(provider, turns)| {
                (
                    provider.clone(),
                    Arc::clone(turns) as Arc<dyn ProviderWindowTurnLegs>,
                )
            })
            .collect();
        let token_limits_legs = HashMap::from([(
            claude(),
            Arc::clone(&turns[&claude()]) as Arc<dyn ProviderTokenLimitsLegs>,
        )]);
        let usage = Arc::new(RecordedQuotaSets::default());
        let wakes = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Installed));
        let notifications = Arc::new(RecordedNotifications::default());
        let held_requests = Arc::new(RecordedHeldRequests::default());
        let request_held = PortRegistration::new("request held");
        request_held
            .register(Arc::clone(&held_requests) as Arc<dyn RequestHeldListener>)
            .expect("a new registration takes its port");
        let observer = ProviderAccountObserver::new(ProviderAccountObserverDeps {
            registry: Arc::clone(&registry),
            account_reader: Arc::new(HomeFolders(Arc::clone(&registry))),
            legs: HashMap::from([(claude(), Arc::clone(&legs) as Arc<dyn ProviderObserveLegs>)]),
            window_turn_legs,
            token_limits_legs,
            token_custody: Arc::new(ProviderTokenCustody::new(
                Arc::clone(&registry),
                Arc::clone(&keychain) as Arc<dyn SecretKeychain>,
                HashMap::new(),
            )),
            database_reads: reads,
            database_writer: Arc::clone(&writer),
            usage: Arc::clone(&usage) as Arc<dyn UsageSink>,
            live_turns: Arc::clone(&live_turns) as Arc<dyn AccountLiveTurns>,
            accounts_in_flight: Arc::clone(&accounts_in_flight),
            home_lock: Arc::clone(&home_lock),
            scheduler: Arc::clone(&scheduler),
            wall_clock: Arc::clone(&clock) as Arc<dyn WallClock>,
            wake_helper: Some(Arc::clone(&wakes) as Arc<dyn MachineWakeHelper>),
            publisher: Arc::clone(&notifications) as Arc<dyn ProviderAccountNotificationPublisher>,
            request_held: Arc::new(request_held),
            daemon_started_at: WireInstant::now(),
        });
        Self {
            registry,
            writer,
            home_lock,
            accounts_in_flight,
            live_turns,
            clock,
            scheduler,
            keychain,
            legs,
            turns,
            usage,
            wakes,
            notifications,
            held_requests,
            observer,
        }
    }

    // Admits a signed-in Claude Code account, observed at the clock's time.
    pub(super) async fn register(&self) -> RegisteredAccount {
        self.register_on(claude(), None).await
    }

    // Admits a signed-in `provider` account whose status read reported `observed_auth_mode`.
    pub(super) async fn register_on(
        &self,
        provider: ProviderId,
        observed_auth_mode: Option<ProviderAuthMode>,
    ) -> RegisteredAccount {
        let minted = self.registry.mint(provider).expect("the account is minted");
        self.registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: Some(HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: super::ladder::wire_instant(self.clock.now()),
                    }),
                    observed_auth_mode,
                },
            )
            .await
            .expect("the account is admitted")
    }

    pub(super) async fn read(
        &self,
        account: &RegisteredAccount,
        asker: ReadAsker,
    ) -> AccountReadAnswer {
        self.observer
            .shared
            .read(account.account_id.clone(), asker)
            .await
            .expect("the account is observed")
    }
}

// Each usage row of `account`: its session and the generation it was charged to.
pub(super) fn usage_rows(
    database: &TestDatabase,
    account: &RegisteredAccount,
) -> Vec<(Option<String>, i64)> {
    let connection = rusqlite::Connection::open(database.path()).expect("the database opens");
    let mut statement = connection
        .prepare(
            "SELECT session_id, observed_credential_generation
               FROM provider_account_usage_turns WHERE account_id = ?",
        )
        .expect("the rows' query prepares");
    statement
        .query_map([account.account_id.as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("the rows read")
        .collect::<Result<_, _>>()
        .expect("each row reads")
}

pub(super) fn new_clock() -> Arc<TestClock> {
    Arc::new(TestClock(Mutex::new(SystemTime::now())))
}

pub(super) fn read_reading(answer: AccountReadAnswer) -> super::AccountReading {
    match answer {
        AccountReadAnswer::Read(reading) => reading,
        other @ (AccountReadAnswer::Held { .. } | AccountReadAnswer::NotNow { .. }) => {
            panic!("a read was taken, not {other:?}")
        }
    }
}
