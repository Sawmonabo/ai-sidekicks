use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::{WallClock, WallClockWait};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
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
use crate::driver::contract::account::{ProviderObservation, ProviderObserveLegs};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
};

// A wall clock the test sets; nothing here arms its timer.
struct TestClock(Mutex<SystemTime>);

impl TestClock {
    fn advance(&self, by: Duration) {
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
struct ScriptedLegs {
    answers: Mutex<VecDeque<Option<ProviderObservation>>>,
    read_count: AtomicUsize,
    reading_now: AtomicUsize,
    most_at_once: AtomicUsize,
    gate: Option<(Arc<Semaphore>, Arc<Notify>)>,
}

impl ScriptedLegs {
    fn answering(answers: impl IntoIterator<Item = Option<ProviderObservation>>) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().collect()),
            ..Self::default()
        }
    }

    fn reads(&self) -> usize {
        self.read_count.load(Ordering::SeqCst)
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
                .unwrap_or(Some(ProviderObservation::Figures));
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

#[derive(Default)]
struct TestLiveTurns(AtomicBool);

impl AccountLiveTurns for TestLiveTurns {
    fn has_live_turn(&self, _provider_account_id: &ProviderAccountId) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

// An accounts reader answering every account's folders as its home.
struct HomeFolders(Arc<ProviderAccountRegistry>);

impl ProviderAccountReader for HomeFolders {
    fn resolve_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        async move {
            let Ok(account) = self.0.read(provider_account_id).await else {
                return Err(AccountFoldersError::NotFound);
            };
            let home = account.credential_home.path().to_path_buf();
            Ok(ProviderAccountFolders {
                configuration_folder: home.clone(),
                credential_store_folder: home,
            })
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
}

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

struct Fixture {
    registry: Arc<ProviderAccountRegistry>,
    home_lock: Arc<AccountHomeLock>,
    live_turns: Arc<TestLiveTurns>,
    clock: Arc<TestClock>,
    legs: Arc<ScriptedLegs>,
    observer: ProviderAccountObserver,
}

impl Fixture {
    // An observer over `database` reading through `legs`, on `clock`.
    async fn open(
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
        let reads = DatabaseReadPool::new(
            database.path(),
            PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
        );
        let registry = Arc::new(ProviderAccountRegistry::new(
            Arc::new(reads),
            writer,
            data_folder.to_owned(),
        ));
        let home_lock = Arc::new(AccountHomeLock::default());
        let live_turns = Arc::new(TestLiveTurns::default());
        let legs = Arc::new(legs);
        let observer = ProviderAccountObserver::new(ProviderAccountObserverDeps {
            registry: Arc::clone(&registry),
            account_reader: Arc::new(HomeFolders(Arc::clone(&registry))),
            legs: HashMap::from([(claude(), Arc::clone(&legs) as Arc<dyn ProviderObserveLegs>)]),
            live_turns: Arc::clone(&live_turns) as Arc<dyn AccountLiveTurns>,
            home_lock: Arc::clone(&home_lock),
            scheduler: Arc::new(Scheduler::start(
                Arc::clone(&clock) as Arc<dyn WallClock>,
                None,
                watch::channel(0).1,
            )),
            wall_clock: Arc::clone(&clock) as Arc<dyn WallClock>,
        });
        Self {
            registry,
            home_lock,
            live_turns,
            clock,
            legs,
            observer,
        }
    }

    // Admits a signed-in Claude Code account, observed at the clock's time.
    async fn register(&self) -> RegisteredAccount {
        let minted = self.registry.mint(claude()).expect("the account is minted");
        self.registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: super::ladder::wire_instant(self.clock.now()),
                    },
                    observed_auth_mode: None,
                },
            )
            .await
            .expect("the account is admitted")
    }

    async fn read(&self, account: &RegisteredAccount, asker: ReadAsker) -> AccountReadAnswer {
        self.observer
            .shared
            .read(account.account_id.clone(), asker)
            .await
            .expect("the account is observed")
    }
}

fn new_clock() -> Arc<TestClock> {
    Arc::new(TestClock(Mutex::new(SystemTime::now())))
}

fn generation(value: u64) -> CredentialGeneration {
    serde_json::from_value(value.into()).expect("a test generation")
}

fn read_reading(answer: AccountReadAnswer) -> super::AccountReading {
    match answer {
        AccountReadAnswer::Read(reading) => reading,
        other @ (AccountReadAnswer::Held { .. } | AccountReadAnswer::NotNow { .. }) => {
            panic!("a read was taken, not {other:?}")
        }
    }
}

// What the account's stored health is after the reads.
#[derive(Clone, Copy, Debug)]
enum Stored {
    // The registration's observation, untouched.
    Unchanged,
    // This state, observed at the last read.
    AtLastRead(ProviderAccountHealthState),
}

// Table T2 over cadence reads, each a hold's length past the last: what each answer stores, where
// the ladder stands and that no background write moves the generation. Killed by a refused or
// unanswered read stored as a reading (the health reads signed in at the read's time), by the
// ladder not climbing or not cleared, by a login gone held on the ladder, by `indeterminate` at
// the first refusal or never, and by a background write that moves the generation.
#[rstest]
#[case::figures_clear_the_ladder(
    vec![Some(ProviderObservation::RefusedInBand), Some(ProviderObservation::Figures)],
    Stored::AtLastRead(ProviderAccountHealthState::Authenticated),
    0
)]
#[case::one_refusal_holds_and_stores_nothing(
    vec![Some(ProviderObservation::RefusedInBand)],
    Stored::Unchanged,
    1
)]
#[case::a_second_refusal_cannot_tell(
    vec![Some(ProviderObservation::RefusedInBand), Some(ProviderObservation::RefusedInBand)],
    Stored::AtLastRead(ProviderAccountHealthState::Indeterminate),
    2
)]
#[case::a_sign_in_gone_is_never_held(
    vec![Some(ProviderObservation::SignInGone)],
    Stored::AtLastRead(ProviderAccountHealthState::ReauthRequired),
    0
)]
#[case::a_token_s_scope_stores_nothing(
    vec![Some(ProviderObservation::OutOfScope), Some(ProviderObservation::OutOfScope)],
    Stored::Unchanged,
    0
)]
#[case::one_unanswered_read_stores_nothing(
    vec![Some(ProviderObservation::Unanswered)],
    Stored::Unchanged,
    0
)]
#[case::a_second_read_with_no_answer_cannot_tell(
    vec![Some(ProviderObservation::Unanswered), None],
    Stored::AtLastRead(ProviderAccountHealthState::Indeterminate),
    0
)]
#[case::a_sign_in_refused_on_the_way_cannot_tell_at_once(
    vec![Some(ProviderObservation::SignInRefusedBeforeAnswer)],
    Stored::AtLastRead(ProviderAccountHealthState::Indeterminate),
    1
)]
#[tokio::test]
async fn each_answer_stores_what_table_t2_says(
    #[case] answers: Vec<Option<ProviderObservation>>,
    #[case] stored: Stored,
    #[case] rung: u32,
) {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let read_count = answers.len();
    let fixture = Fixture::open(
        &database,
        data_folder.path(),
        new_clock(),
        ScriptedLegs::answering(answers),
    )
    .await;
    let account = fixture.register().await;
    let mut last = None;
    for _ in 0..read_count {
        fixture.clock.advance(Duration::from_mins(61));
        last = Some(read_reading(
            fixture.read(&account, ReadAsker::Cadence).await,
        ));
    }
    let last = last.expect("at least one read");

    let read = fixture
        .registry
        .read(account.account_id.clone())
        .await
        .expect("the account reads");
    let expected = match stored {
        Stored::Unchanged => account.health.clone(),
        Stored::AtLastRead(state) => Some(HealthObservation {
            state,
            observed_at: last.read_at.clone(),
        }),
    };
    assert_eq!(read.health, expected);
    assert_eq!(read.credential_generation, generation(1));
    let hold = fixture
        .registry
        .read_hold(account.account_id.clone())
        .await
        .expect("the ladder reads");
    assert_eq!(hold.rung, rung);
    assert_eq!(fixture.legs.reads(), read_count);
}

// A hold set before a restart still holds the reopened store's observer, which answers the wait
// and reads only once the hold has ended. Killed by the ladder kept in memory, which a reopened
// observer would not have.
#[tokio::test]
async fn the_ladder_survives_a_store_reopen() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let clock = new_clock();
    let before = Fixture::open(
        &database,
        data_folder.path(),
        Arc::clone(&clock),
        ScriptedLegs::answering([Some(ProviderObservation::RefusedInBand)]),
    )
    .await;
    let account = before.register().await;
    let refused = read_reading(before.read(&account, ReadAsker::Cadence).await);
    drop(before);

    let after = Fixture::open(
        &database,
        data_folder.path(),
        Arc::clone(&clock),
        ScriptedLegs::default(),
    )
    .await;
    clock.advance(Duration::from_mins(9));
    let until = super::ladder::wire_instant(
        refused
            .read_at
            .timestamp()
            .map(SystemTime::from)
            .expect("the read's time parses")
            + Duration::from_mins(10),
    );
    assert_eq!(
        after
            .observer
            .check_now(account.account_id.clone())
            .await
            .expect("the check answers"),
        AccountReadAnswer::Held { until }
    );
    assert_eq!(after.legs.reads(), 0);

    clock.advance(Duration::from_mins(2));
    read_reading(
        after
            .observer
            .check_now(account.account_id.clone())
            .await
            .expect("a read"),
    );
    assert_eq!(after.legs.reads(), 1);
}

// No read runs while a turn is live on the account or a sign-in holds its home, the opt-out aside.
// Killed by the live-turn check or the home's hold being skipped, either of which reads.
#[tokio::test]
async fn no_read_runs_while_a_turn_is_live_or_a_sign_in_holds_the_home() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let fixture = Fixture::open(
        &database,
        data_folder.path(),
        new_clock(),
        ScriptedLegs::default(),
    )
    .await;
    let account = fixture.register().await;
    let not_yet = AccountReadAnswer::NotNow { last: None };

    fixture.live_turns.0.store(true, Ordering::SeqCst);
    assert_eq!(fixture.read(&account, ReadAsker::CheckNow).await, not_yet);
    assert_eq!(fixture.read(&account, ReadAsker::Cadence).await, not_yet);
    fixture.live_turns.0.store(false, Ordering::SeqCst);

    // A sign-in holds the account's home for its whole attempt.
    let sign_in = fixture.home_lock.hold(account.account_id.clone()).await;
    assert_eq!(fixture.read(&account, ReadAsker::CheckNow).await, not_yet);
    assert_eq!(fixture.read(&account, ReadAsker::Dictation).await, not_yet);
    assert_eq!(fixture.legs.reads(), 0);
    drop(sign_in);

    read_reading(fixture.read(&account, ReadAsker::CheckNow).await);
    assert_eq!(fixture.legs.reads(), 1);
}

// `Check now` inside a minute of the last read answers that read, and while the ladder holds the
// account it answers the hold's end. Killed by the floor skipped (a second read) and by a held
// account read anyway.
#[tokio::test]
async fn check_now_answers_the_last_read_inside_a_minute_and_the_wait_during_a_hold() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let fixture = Fixture::open(
        &database,
        data_folder.path(),
        new_clock(),
        ScriptedLegs::answering([
            Some(ProviderObservation::Figures),
            Some(ProviderObservation::RefusedInBand),
        ]),
    )
    .await;
    let account = fixture.register().await;
    let id = || account.account_id.clone();

    let first = fixture.observer.check_now(id()).await.expect("a read");
    fixture.clock.advance(Duration::from_secs(30));
    assert_eq!(
        fixture
            .observer
            .check_now(id())
            .await
            .expect("the last read"),
        first
    );
    assert_eq!(fixture.legs.reads(), 1);

    fixture.clock.advance(Duration::from_secs(31));
    let refused = read_reading(fixture.observer.check_now(id()).await.expect("a read"));
    assert_eq!(
        refused.observation,
        Some(ProviderObservation::RefusedInBand)
    );
    fixture.clock.advance(Duration::from_mins(2));
    let until = super::ladder::wire_instant(
        refused
            .read_at
            .timestamp()
            .map(SystemTime::from)
            .expect("the read's time parses")
            + Duration::from_mins(10),
    );
    assert_eq!(
        fixture.observer.check_now(id()).await.expect("the wait"),
        AccountReadAnswer::Held { until }
    );
    assert_eq!(fixture.legs.reads(), 2);
}

// A dictation's read asked while the five-minute read is in flight waits for that read and answers
// it, so one read runs in the home. Killed by the single flight dropped, which reads twice, two at
// once.
#[tokio::test]
async fn a_dictation_read_joins_the_five_minute_read_in_flight() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let permits = Arc::new(Semaphore::new(0));
    let entered = Arc::new(Notify::new());
    let legs = ScriptedLegs {
        gate: Some((Arc::clone(&permits), Arc::clone(&entered))),
        ..ScriptedLegs::default()
    };
    let fixture = Arc::new(Fixture::open(&database, data_folder.path(), new_clock(), legs).await);
    let account = fixture.register().await;

    let cadence = tokio::spawn({
        let (fixture, account) = (Arc::clone(&fixture), account.clone());
        async move { fixture.read(&account, ReadAsker::Cadence).await }
    });
    entered.notified().await;
    let dictation = tokio::spawn({
        let fixture = Arc::clone(&fixture);
        async move {
            fixture
                .observer
                .read_for_dictation(account.account_id.clone())
                .await
        }
    });
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    permits.add_permits(2);

    let cadence = cadence.await.expect("the cadence read ends");
    let dictation = dictation
        .await
        .expect("the dictation read ends")
        .expect("the dictation read answers");
    assert_eq!(dictation, cadence);
    assert_eq!(fixture.legs.reads(), 1);
    assert_eq!(fixture.legs.most_at_once.load(Ordering::SeqCst), 1);
}
