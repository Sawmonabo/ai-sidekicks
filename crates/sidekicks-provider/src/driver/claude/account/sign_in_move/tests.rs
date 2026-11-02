use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use futures::stream::StreamExt as _;
use rstest::rstest;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountSignInRequest, RegisteredAccountSignIn,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{BlockingCredentialStore, CredentialStore, sign_in_move};
use sidekicks_store::credential_store::place::{
    PlaceRecord, SecretsPlace, record_path, write_record,
};
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;
use tracing_subscriber::layer::SubscriberExt as _;

use super::{
    CLAUDE_SIGN_IN_MOVE_KEYCHAIN_WAIT, ClaudeSignInMoveBounds, ClaudeSignInMoveError,
    call_keychain_within, remove_claude_sign_in_move_leftovers,
};
use crate::account::credential_home::CredentialHome;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::registry::{
    AccountAdmission, HealthObservation, ProviderAccountRegistry, RegisteredAccount,
    open_test_registry,
};
use crate::account::sign_in::{
    AccountsInFlight, ProviderAccountNotificationPublisher, ProviderSignInBroker,
    ProviderSignInError, SignedInAccountWatcher,
};
use crate::driver::claude::account::credentials::{
    SECURE_STORAGE_FOLDER_VARIABLE, claude_keychain_account, claude_keychain_service,
};
use crate::driver::claude::account::{ClaudeAccountLegs, test_account_legs};
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs,
    ProviderSignInObservation, SignInOrigin,
};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::{new_session_id, test_driver_services};

// The bytes of every planted sign-in carry this, so no log line or error may.
const PLANTED_SECRET: &str = "planted-sign-in-secret";

// The user name every Claude Code process of the test runs as, which names its keychain item.
const USER: &str = "tester";

// What may appear in the move's log: its one summary line.
const ALLOWED_LOG_MESSAGES: [&str; 1] = ["the Claude Code sign-ins moved"];

#[derive(Clone, Default)]
struct CapturedLines(Arc<Mutex<Vec<u8>>>);

impl Write for CapturedLines {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("the capture is not poisoned")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// The sessions with a turn live on the one account set here.
#[derive(Default)]
struct LiveTurns(Mutex<Option<(ProviderAccountId, SessionId)>>);

impl AccountLiveTurns for LiveTurns {
    fn sessions_with_live_turns(&self, provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        self.0
            .lock()
            .expect("the turns are not poisoned")
            .iter()
            .filter(|(account, _)| account == provider_account_id)
            .map(|(_, session)| *session)
            .collect()
    }
}

// A sign-in that waits for ever for the person, so it holds its account while the test runs.
struct WaitingSignIn;

struct NoInput;

impl ProviderSignInInput for NoInput {
    fn write_code(
        &self,
        _code: FreeFormText<
            { sidekicks_contracts::provider::account::sign_in::PROVIDER_SIGN_IN_CODE_MAX_LEN },
        >,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        async { Ok(()) }.boxed()
    }

    fn cancel(&self) -> BoxFuture<'_, Result<(), DriverError>> {
        async { Ok(()) }.boxed()
    }
}

impl ProviderSignInLegs for WaitingSignIn {
    fn start_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
        _origin: SignInOrigin,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        async {
            Ok(ProviderSignInHandle {
                verification_uri: HttpsAddress::new("https://claude.ai/oauth/authorize")
                    .expect("an https address"),
                user_code: None,
                expires_at: None,
                browser_opened_by_provider: false,
                code_prompts: futures::stream::pending().boxed(),
                input: Box::new(NoInput),
                completion: futures::future::pending::<ProviderSignInEnd>().boxed(),
            })
        }
        .boxed()
    }

    fn observe_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        async { Err(DriverError::Internal("the sign-in never ends".into())) }.boxed()
    }
}

struct Unheard;

impl ProviderAccountNotificationPublisher for Unheard {
    fn publish(
        &self,
        _notification: sidekicks_contracts::provider::account::record::ProviderAccountNotification,
    ) {
    }
}

impl SignedInAccountWatcher for Unheard {
    fn watch_signed_in(&self, _account: &RegisteredAccount) {}
}

struct Fixture {
    data_folder: TempDir,
    _own_home: TempDir,
    _database: TestDatabase,
    registry: Arc<ProviderAccountRegistry>,
    legs: ClaudeAccountLegs,
    home_lock: Arc<AccountHomeLock>,
    sign_ins: ProviderSignInBroker,
    accounts_in_flight: Arc<AccountsInFlight>,
    live_turns: LiveTurns,
    keychain: CredentialStore,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_keychain(CredentialStore::in_memory()).await
    }

    // The sign-in broker and the move share one home lock, as the daemon wires them.
    async fn with_keychain(keychain: CredentialStore) -> Self {
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let own_home = tempfile::tempdir().expect("the person's own home is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let registry = Arc::new(registry);
        let mut services = test_driver_services();
        services.data_folder = data_folder.path().to_owned();
        services.home_folder = own_home.path().to_owned();
        services.base_environment = Arc::from([
            ("HOME".to_owned(), own_home.path().display().to_string()),
            ("USER".to_owned(), USER.to_owned()),
        ]);
        let legs = test_account_legs(&services, Weak::new());
        let home_lock = Arc::new(AccountHomeLock::default());
        let accounts_in_flight = Arc::new(AccountsInFlight::default());
        let sign_ins = ProviderSignInBroker::new(
            Arc::clone(&registry),
            HashMap::from([(
                claude(),
                Arc::new(WaitingSignIn) as Arc<dyn ProviderSignInLegs>,
            )]),
            Arc::new(Unheard),
            Arc::new(Unheard),
            Arc::clone(&home_lock),
            Arc::clone(&accounts_in_flight),
        );
        Self {
            data_folder,
            _own_home: own_home,
            _database: database,
            registry,
            legs,
            home_lock,
            sign_ins,
            accounts_in_flight,
            live_turns: LiveTurns::default(),
            keychain,
        }
    }

    fn bounds(&self) -> ClaudeSignInMoveBounds<'_> {
        ClaudeSignInMoveBounds {
            registry: &self.registry,
            home_lock: self.home_lock.as_ref(),
            accounts_in_flight: &self.accounts_in_flight,
            live_turns: &self.live_turns,
            keychain: &self.keychain,
            keychain_wait: CLAUDE_SIGN_IN_MOVE_KEYCHAIN_WAIT,
        }
    }

    async fn account(&self, provider: ProviderId) -> RegisteredAccount {
        let minted = self.registry.mint(provider).expect("the account is minted");
        self.registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: Some(HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: WireInstant::now(),
                    }),
                    observed_auth_mode: None,
                },
            )
            .await
            .expect("the account is admitted")
    }

    async fn record(&self, place: SecretsPlace) {
        write_record(
            &record_path(self.data_folder.path()),
            &PlaceRecord::settled(place),
        )
        .await
        .expect("the place record is written");
    }

    // Plants a sign-in in the keychain item Claude Code files for the store folder `store`.
    fn plant(&self, store: &Path) -> PlantedSignIn {
        let planted = PlantedSignIn::for_store(store);
        self.keychain
            .write(
                &planted.service,
                &planted.account,
                &SecretString::from(planted.text()),
            )
            .expect("the item is planted");
        planted
    }

    fn item(&self, planted: &PlantedSignIn) -> Option<String> {
        self.keychain
            .read(&planted.service, &planted.account)
            .expect("the store reads")
            .map(|value| value.expose_secret().to_owned())
    }
}

// A sign-in in the keychain item named for a store folder, as Claude Code started on that folder
// names it, and the file it moves to.
struct PlantedSignIn {
    service: String,
    account: String,
    file: PathBuf,
}

impl PlantedSignIn {
    fn for_store(store: &Path) -> Self {
        let environment = [
            (
                SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
                store.display().to_string(),
            ),
            ("USER".to_owned(), USER.to_owned()),
        ];
        Self {
            service: claude_keychain_service(&environment),
            account: claude_keychain_account(&environment),
            file: store.join(".credentials.json"),
        }
    }

    fn text(&self) -> String {
        format!(
            r#"{{"claudeAiOauth":{{"accessToken":"{PLANTED_SECRET}-{}"}}}}"#,
            self.service
        )
    }

    fn file(&self) -> Option<String> {
        std::fs::read_to_string(&self.file).ok()
    }
}

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

fn codex() -> ProviderId {
    ProviderId::new("codex".to_owned()).expect("the Codex provider id")
}

fn store_folder(account: &RegisteredAccount) -> PathBuf {
    account.credential_home.path().join("store")
}

// Each registered Claude Code account's sign-in moves into its store folder's file and back, while
// a Codex account's home and an unregistered folder's item are never touched, each guarded by a
// refused next call that would stop the move; no log line holds a sign-in byte and each is a line
// the allow-list names. Killed by moving every account rather than Claude Code's (the Codex item's
// refusal stops the move), by a folder no registry names moved, and by the direction read from
// anything but the record.
#[tokio::test]
async fn the_move_takes_only_registered_claude_code_sign_ins_and_brings_them_back() {
    let fixture = Fixture::new().await;
    let claude_account = fixture.account(claude()).await;
    let codex_account = fixture.account(codex()).await;
    let moved = fixture.plant(&store_folder(&claude_account));
    let codex_item = fixture.plant(codex_account.credential_home.path());
    let unregistered = fixture.plant(&fixture.data_folder.path().join("homes/unregistered/store"));
    for untouched in [&codex_item, &unregistered] {
        fixture
            .keychain
            .refuse_next_call(&untouched.service, &untouched.account);
    }
    let lines = CapturedLines::default();
    let writer = lines.clone();
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_writer(move || writer.clone())
            .with_ansi(false),
    );
    let _default = tracing::subscriber::set_default(subscriber);
    let does_system_move = sign_in_move().is_some();

    fixture.record(SecretsPlace::LoggedOutServiceFile).await;
    fixture
        .legs
        .move_sign_ins(fixture.bounds())
        .await
        .expect("the sign-ins move into the files");

    if does_system_move {
        assert_eq!(
            (fixture.item(&moved), moved.file()),
            (None, Some(moved.text()))
        );
    } else {
        assert_eq!(
            (fixture.item(&moved), moved.file()),
            (Some(moved.text()), None)
        );
    }
    assert_eq!(codex_item.file(), None);
    assert_eq!(unregistered.file(), None);

    fixture.record(SecretsPlace::OperatingSystem).await;
    fixture
        .legs
        .move_sign_ins(fixture.bounds())
        .await
        .expect("the sign-ins move back into the keychain");

    assert_eq!(
        (fixture.item(&moved), moved.file()),
        (Some(moved.text()), None)
    );
    for untouched in [&codex_item, &unregistered] {
        assert!(
            fixture
                .keychain
                .read(&untouched.service, &untouched.account)
                .is_err(),
            "the item was never read, so its refused call still waits"
        );
        assert_eq!(fixture.item(untouched), Some(untouched.text()));
    }
    let log = String::from_utf8(lines.0.lock().expect("the capture").clone()).expect("text");
    assert!(!log.contains(PLANTED_SECRET), "{log}");
    for line in log.lines() {
        assert!(
            ALLOWED_LOG_MESSAGES
                .iter()
                .any(|message| line.contains(message)),
            "{line}"
        );
    }
}

// What holds the account's home while the move runs.
#[derive(Clone, Copy, Debug)]
enum HomeUse {
    Observation,
    SignIn,
    Turn,
}

// Nothing moves while an observation, a sign-in or a turn holds the account's home: the move
// waits out an observation and then moves, and refuses a sign-in or a turn at once, even while an
// observation holds the home too, naming the account and no sign-in byte, the sign-in left in its
// item. Killed by the move taken without the home's hold, by either use not read, and by either
// use read only once the hold is taken.
#[rstest]
#[case::an_observation(HomeUse::Observation)]
#[case::a_sign_in(HomeUse::SignIn)]
#[case::a_turn(HomeUse::Turn)]
#[tokio::test]
async fn nothing_moves_while_the_home_is_in_use(#[case] home_use: HomeUse) {
    let fixture = Fixture::new().await;
    let account = fixture.account(claude()).await;
    let planted = fixture.plant(&store_folder(&account));
    fixture.record(SecretsPlace::LoggedOutServiceFile).await;
    match home_use {
        HomeUse::Observation => {}
        HomeUse::SignIn => {
            fixture
                .sign_ins
                .start(
                    ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
                        account_id: account.account_id.clone(),
                    }),
                    SignInOrigin::ThisMachine,
                )
                .await
                .expect("the sign-in starts");
        }
        HomeUse::Turn => {
            *fixture.live_turns.0.lock().expect("the turns") =
                Some((account.account_id.clone(), new_session_id()));
        }
    }
    let held = fixture.home_lock.hold(account.account_id.clone()).await;

    let mut moving = std::pin::pin!(fixture.legs.move_sign_ins(fixture.bounds()));
    let answer = tokio::time::timeout(Duration::from_millis(100), &mut moving).await;

    assert_eq!(fixture.item(&planted), Some(planted.text()));
    assert_eq!(planted.file(), None);
    match (home_use, answer) {
        (HomeUse::SignIn | HomeUse::Turn, Ok(Ok(()))) if sign_in_move().is_none() => {}
        (HomeUse::Observation, Err(_waiting)) => {
            drop(held);
            moving
                .await
                .expect("the move runs once the observation ends");
            if sign_in_move().is_some() {
                assert_eq!(planted.file(), Some(planted.text()));
            }
        }
        (HomeUse::SignIn | HomeUse::Turn, Ok(Err(refused))) => {
            assert!(
                matches!(
                    &refused,
                    ClaudeSignInMoveError::HomeInUse { provider_account_id }
                        if *provider_account_id == account.account_id
                ),
                "{refused:?}"
            );
            let shown = format!("{refused} {refused:?}");
            assert!(!shown.contains(PLANTED_SECRET), "{shown}");
        }
        (home_use, answer) => panic!("{home_use:?} answered {answer:?}"),
    }
}

// A locked keychain refuses the move at once, while an observation holds the account's home: the
// keychain is read before the home is held, so a refusal or a prompt never waits on, or holds, the
// home. Killed by the keychain first read under the home's hold.
#[tokio::test]
async fn a_locked_keychain_refuses_the_move_without_waiting_on_the_home() {
    if sign_in_move().is_none() {
        return;
    }
    let fixture = Fixture::new().await;
    let account = fixture.account(claude()).await;
    let planted = fixture.plant(&store_folder(&account));
    fixture.record(SecretsPlace::LoggedOutServiceFile).await;
    let _observation = fixture.home_lock.hold(account.account_id.clone()).await;
    fixture
        .keychain
        .refuse_next_call(&planted.service, &planted.account);

    let answer = tokio::time::timeout(
        Duration::from_millis(100),
        fixture.legs.move_sign_ins(fixture.bounds()),
    )
    .await
    .expect("the refusal comes without waiting for the home");

    assert!(
        matches!(answer, Err(ClaudeSignInMoveError::Move(_))),
        "{answer:?}"
    );
    assert_eq!(fixture.item(&planted), Some(planted.text()));
    assert_eq!(planted.file(), None);
}

// A keychain call that never answers, as an access prompt left open does not, stops the move at
// its bound naming the account. Killed by the call awaited with no bound.
#[tokio::test(start_paused = true)]
async fn a_keychain_call_that_never_answers_stops_the_move_naming_the_account() {
    let account =
        ProviderAccountId::new("account-prompted".to_owned()).expect("an account id fits");
    let (_never_answered, answer) = std::sync::mpsc::channel::<()>();

    let called = call_keychain_within(Duration::from_secs(5), &account, move || {
        // Ends once the test lets the sender go, which sends nothing.
        answer.recv().unwrap_or(());
        Ok(())
    })
    .await;

    assert!(
        matches!(
            &called,
            Err(ClaudeSignInMoveError::KeychainUnanswered { provider_account_id })
                if *provider_account_id == account
        ),
        "{called:?}"
    );
}

// Polls the move while it waits for `wait`; the move must not end meanwhile.
async fn while_moving<Answer>(
    moving: &mut Pin<&mut impl Future<Output = Result<(), ClaudeSignInMoveError>>>,
    wait: impl Future<Output = Answer>,
) -> Answer {
    tokio::select! {
        biased;
        answer = wait => answer,
        moved = moving.as_mut() => panic!("the move ended early: {moved:?}"),
    }
}

// A move under the home's hold whose keychain call never answers within its bound stops naming
// the account and lets the home go, so a prompt left open keeps no observation out of it; the
// account stays in flight until that call ends, so a sign-in on it is refused meanwhile and starts
// once the call has ended, the stopped move having written nothing and the next call finishing it.
// Killed by the whole move awaited with no bound (the move waits for the release), by the account
// not held in flight by the move's task (the sign-in starts while the call runs), by it held past
// the call's end, and by a stopped move that writes on or leaves the next one stuck.
#[tokio::test]
async fn a_move_past_its_bound_lets_the_home_go_and_holds_the_account_until_its_call_ends() {
    if sign_in_move().is_none() {
        return;
    }
    let blocking = BlockingCredentialStore::new();
    blocking.release();
    let fixture = Fixture::with_keychain(CredentialStore::from_store(blocking.clone())).await;
    let account = fixture.account(claude()).await;
    let planted = fixture.plant(&store_folder(&account));
    fixture.record(SecretsPlace::LoggedOutServiceFile).await;
    let bounds = ClaudeSignInMoveBounds {
        keychain_wait: Duration::from_millis(50),
        ..fixture.bounds()
    };
    let sign_in = || {
        fixture.sign_ins.start(
            ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
                account_id: account.account_id.clone(),
            }),
            SignInOrigin::ThisMachine,
        )
    };
    let observation = fixture.home_lock.hold(account.account_id.clone()).await;
    let mut moving = std::pin::pin!(fixture.legs.move_sign_ins(bounds));

    // The read before the hold answers, and the move waits for the home.
    while_moving(&mut moving, blocking.wait_for_calls(2)).await;
    while_moving(&mut moving, tokio::time::sleep(Duration::from_millis(100))).await;
    blocking.hold_calls_for(&planted.service);
    drop(observation);
    let stopped = tokio::time::timeout(Duration::from_secs(5), moving)
        .await
        .expect("the move stops at its bound while its call still waits");
    let is_home_free = tokio::time::timeout(
        Duration::from_millis(50),
        fixture.home_lock.hold(account.account_id.clone()),
    )
    .await
    .is_ok();
    let while_running = sign_in().await;
    blocking.release();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.accounts_in_flight.is_in_flight(&account.account_id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the account leaves flight once the call ends");
    let file_once_ended = planted.file();
    let after = fixture
        .legs
        .move_sign_ins(ClaudeSignInMoveBounds {
            keychain_wait: Duration::from_millis(50),
            ..fixture.bounds()
        })
        .await;
    let once_ended = sign_in().await;

    assert!(
        matches!(
            &stopped,
            Err(ClaudeSignInMoveError::KeychainUnanswered { provider_account_id })
                if *provider_account_id == account.account_id
        ),
        "{stopped:?}"
    );
    assert!(is_home_free, "the home is let go at the bound");
    assert!(
        matches!(while_running, Err(ProviderSignInError::InFlight)),
        "{while_running:?}"
    );
    assert!(once_ended.is_ok(), "{once_ended:?}");
    assert_eq!(file_once_ended, None);
    assert!(after.is_ok(), "{after:?}");
    assert_eq!(planted.file(), Some(planted.text()));
}

// The start's sweep removes the leftover a move stopped mid-write left beside a Claude Code
// account's sign-in file, and leaves the same name in a Codex account's home. Killed by a sweep
// that misses the store folder, and by one over every provider's accounts.
#[tokio::test]
async fn the_start_sweeps_a_stopped_moves_leftover() {
    let fixture = Fixture::new().await;
    let claude_account = fixture.account(claude()).await;
    let codex_account = fixture.account(codex()).await;
    let leftover_name = ".credentials.json.a1b2c3.tmp";
    let claude_leftover = store_folder(&claude_account).join(leftover_name);
    let codex_leftover = store_folder(&codex_account).join(leftover_name);
    for leftover in [&claude_leftover, &codex_leftover] {
        std::fs::create_dir_all(leftover.parent().expect("a leftover has a folder"))
            .expect("the store folder is made");
        std::fs::write(leftover, PLANTED_SECRET).expect("the leftover is written");
    }

    let failures = remove_claude_sign_in_move_leftovers(&fixture.registry)
        .await
        .expect("the sweep runs");

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(claude_leftover.exists(), sign_in_move().is_none());
    assert!(codex_leftover.exists(), "a Codex account's file stays");
}
