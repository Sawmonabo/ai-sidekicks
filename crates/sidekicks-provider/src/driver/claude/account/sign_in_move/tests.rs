use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
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
use sidekicks_platforms::{CredentialStore, sign_in_move};
use sidekicks_store::credential_store::place::{
    PlaceRecord, SecretsPlace, record_path, write_record,
};
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;
use tracing_subscriber::layer::SubscriberExt as _;

use super::{ClaudeSignInMoveBounds, ClaudeSignInMoveError, call_keychain_within};
use crate::account::credential_home::CredentialHome;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::registry::{
    AccountAdmission, HealthObservation, ProviderAccountRegistry, RegisteredAccount,
    open_test_registry,
};
use crate::account::sign_in::{
    ProviderAccountNotificationPublisher, ProviderSignInBroker, SignedInAccountWatcher,
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
    home_lock: AccountHomeLock,
    sign_ins: ProviderSignInBroker,
    live_turns: LiveTurns,
    keychain: CredentialStore,
}

impl Fixture {
    async fn new() -> Self {
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
        let sign_ins = ProviderSignInBroker::new(
            Arc::clone(&registry),
            HashMap::from([(
                claude(),
                Arc::new(WaitingSignIn) as Arc<dyn ProviderSignInLegs>,
            )]),
            Arc::new(Unheard),
            Arc::new(Unheard),
        );
        Self {
            data_folder,
            _own_home: own_home,
            _database: database,
            registry,
            legs,
            home_lock: AccountHomeLock::default(),
            sign_ins,
            live_turns: LiveTurns::default(),
            keychain: CredentialStore::in_memory(),
        }
    }

    fn bounds(&self) -> ClaudeSignInMoveBounds<'_> {
        ClaudeSignInMoveBounds {
            registry: &self.registry,
            home_lock: &self.home_lock,
            sign_ins: &self.sign_ins,
            live_turns: &self.live_turns,
            keychain: &self.keychain,
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

// Each registered Claude Code account's sign-in moves into its store folder's file and back, while a Codex account's home and an unregistered folder's item are never touched, each
// guarded by a refused next call that would stop the move; no log line holds a sign-in byte and
// each is a line the allow-list names. Killed by moving every account rather than Claude Code's
// (the Codex item's refusal stops the move), by a folder no registry names moved, and by the
// direction read from anything but the record.
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
// waits out an observation and then moves, and refuses a sign-in or a turn, naming the account
// and no sign-in byte, the sign-in left in its item. Killed by the move taken without the home's
// hold, and by either use not read.
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
    let held = match home_use {
        HomeUse::Observation => Some(fixture.home_lock.hold(account.account_id.clone()).await),
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
            None
        }
        HomeUse::Turn => {
            *fixture.live_turns.0.lock().expect("the turns") =
                Some((account.account_id.clone(), new_session_id()));
            None
        }
    };

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
