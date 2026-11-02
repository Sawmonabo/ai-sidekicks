//! The current-account switch over a test database, the real account registry and folder reader,
//! a driver whose level list the test names, and switch legs and a level control that record what
//! they were asked and answer as the test scripts.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::driver::capabilities::ProviderMode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::account::registry::{
    AccountAdmission, HealthObservation, HealthObserver, ProviderAccountRegistry,
};
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::account::{
    FirstRequestAfterMove, ProviderSwitchLegs, SessionAccountMove, SessionToMove,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::runtime_binding::store::{CreateRuntimeBindingInput, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build,
};
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;

use super::{AccountSwitch, AccountSwitchDeps, SessionLevelMoves};
use crate::daemon::schema::schema_parts;

// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 64;

fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

// A keychain holding no token, which no account the tests register reads.
struct NoTokens;

impl SecretKeychain for NoTokens {
    fn write<'call>(
        &'call self,
        _account: &'call str,
        _value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        async {
            Err(KeychainRefusal::of_test_keychain(
                KeychainRefusalCause::Unavailable,
            ))
        }
        .boxed()
    }

    fn read<'call>(
        &'call self,
        _account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        async { Ok(None) }.boxed()
    }

    fn remove<'call>(
        &'call self,
        _account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        async { Ok(false) }.boxed()
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        async { Ok(Vec::new()) }.boxed()
    }
}

// How a scripted move of one session goes: it lands and its first request reads as given, or the
// provider refuses it.
#[derive(Clone, Copy)]
enum ScriptedMove {
    Lands(FirstRequestAfterMove),
    Refused,
}

// Switch legs recording each call and answering each session as scripted; a session not scripted
// lands with its first request run.
#[derive(Default)]
struct RecordedSwitchLegs {
    script: Mutex<HashMap<SessionId, ScriptedMove>>,
    calls: Mutex<Vec<(ProviderAccountId, ProviderAccountId, Vec<SessionToMove>)>>,
}

impl ProviderSwitchLegs for RecordedSwitchLegs {
    fn move_sessions(
        &self,
        from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>> {
        lock(&self.calls).push((from, to, sessions.clone()));
        let script = lock(&self.script).clone();
        async move {
            sessions
                .into_iter()
                .map(|session| {
                    let scripted = script
                        .get(&session.session_id)
                        .copied()
                        .unwrap_or(ScriptedMove::Lands(FirstRequestAfterMove::Ran));
                    match scripted {
                        ScriptedMove::Lands(first) => Ok(SessionAccountMove {
                            session_id: session.session_id,
                            first_request: futures::future::ready(Ok(first)).boxed(),
                        }),
                        ScriptedMove::Refused => Err((
                            session.session_id,
                            DriverError::from(DomainError::new(
                                "The provider refused the login",
                                RefusalCode::ProviderAccountNotAuthenticated,
                            )),
                        )),
                    }
                })
                .collect()
        }
        .boxed()
    }
}

// The level control's move, recorded.
#[derive(Default)]
struct RecordedLevelMoves(Mutex<Vec<(SessionId, PermissionLevel)>>);

impl SessionLevelMoves for RecordedLevelMoves {
    fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.0).push((session_id, level));
        async { Ok(()) }.boxed()
    }
}

struct Fixture {
    database: TestDatabase,
    _log: TestLog,
    _data_folder: TempDir,
    accounts: Arc<ProviderAccountRegistry>,
    bindings: RuntimeBindingStore,
    legs: Arc<RecordedSwitchLegs>,
    level_moves: Arc<RecordedLevelMoves>,
    switch: Arc<AccountSwitch>,
}

// Over a driver whose level list for any account and model leaves out `reviewed`.
async fn fixture() -> Fixture {
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
    let mut driver = MockProviderDriver::new();
    driver.expect_list_modes().returning(|_params| {
        let ask = FreeFormText::new("ask".to_owned()).expect("a mode id");
        futures::future::ready(Ok(vec![ProviderMode {
            id: ask.clone(),
            name: ask,
        }]))
        .boxed()
    });
    let legs = Arc::new(RecordedSwitchLegs::default());
    let level_moves = Arc::new(RecordedLevelMoves::default());
    let switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
        accounts: Arc::clone(&accounts),
        account_reader: Arc::new(ProviderAccounts::new(
            Arc::clone(&reads),
            Arc::new(NoTokens),
        )),
        switch_legs: HashMap::from([(
            first_provider(),
            Arc::clone(&legs) as Arc<dyn ProviderSwitchLegs>,
        )]),
        providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
        level_moves: Arc::clone(&level_moves) as Arc<dyn SessionLevelMoves>,
        appender: Arc::new(SessionEventAppender::new(
            Arc::clone(&log.service),
            SESSION_EVENT_VERSION.clone(),
        )),
        reads: Arc::clone(&reads),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None::<i64>),
    }));
    let bindings = RuntimeBindingStore::new(reads, Arc::clone(&log.writer));
    Fixture {
        database,
        _log: log,
        _data_folder: data_folder,
        accounts,
        bindings,
        legs,
        level_moves,
        switch,
    }
}

fn actor() -> DeviceId {
    DeviceId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a device id")
}

impl Fixture {
    // Registers an account of the first provider in `health`; the provider's first is current.
    async fn register(&self, health: ProviderAccountHealthState) -> ProviderAccountId {
        let minted = self
            .accounts
            .mint(first_provider())
            .expect("the account mints");
        self.accounts
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
            .expect("the account is admitted");
        let account_id = minted.account_id().clone();
        if health != ProviderAccountHealthState::Authenticated {
            self.accounts
                .record_health(
                    &account_id,
                    &HealthObservation {
                        state: health,
                        observed_at: WireInstant::now(),
                    },
                    HealthObserver::Background,
                )
                .await
                .expect("the reading is stored");
        }
        account_id
    }

    // An active session whose lead runs on `provider` on `account`, at `level`, with a binding of
    // a run of its on that account where `has_run`.
    async fn session(
        &self,
        provider: &str,
        account: &ProviderAccountId,
        level: PermissionLevel,
        has_run: bool,
    ) -> SessionId {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let connection = self.database.reader();
        insert_session_row(&connection, session_id.text().as_str(), None, None);
        connection
            .execute(
                "UPDATE sessions SET permission_level = ?1 WHERE id = ?2",
                params![<&str>::from(level), session_id.text().as_str()],
            )
            .expect("the test sets the level");
        connection
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
                 VALUES (?1, ?2, 0, '2026-11-01T09:00:00.000Z', 0, 'sessionLifecycle',
                         'session.created', ?3)",
                params![
                    mint_uuid_v7().to_string(),
                    session_id.text().as_str(),
                    json!({
                        "mainAgent": {
                            "agentId": mint_uuid_v7().to_string(),
                            "binding": {
                                "providerName": provider,
                                "modelId": "model-1",
                                "effort": null,
                                "providerAccountId": account.as_str(),
                            },
                        },
                    })
                    .to_string(),
                ],
            )
            .expect("the test creates the session's lead");
        drop(connection);
        if has_run {
            let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
            insert_running_run(&self.database, session_id, run_id);
            self.bindings
                .create(CreateRuntimeBindingInput {
                    run_id,
                    ..binding_input(
                        spawn_config_on(account.clone()),
                        spawned_build("1.0.0", "/opt/provider/bin"),
                    )
                })
                .await
                .expect("the run's binding is recorded");
        }
        session_id
    }

    // Each event the switch appended to `session_id`'s log after its creation: its type and
    // payload, in order.
    fn appended(&self, session_id: SessionId) -> Vec<(String, Value)> {
        let connection = self.database.reader();
        let mut statement = connection
            .prepare(
                "SELECT type, payload FROM session_events
                  WHERE session_id = ?1 AND type != 'session.created' ORDER BY sequence",
            )
            .expect("the read prepares");
        statement
            .query_map([session_id.text().as_str()], |row| {
                let payload: String = row.get(1)?;
                Ok((
                    row.get(0)?,
                    serde_json::from_str(&payload).expect("a stored payload is JSON"),
                ))
            })
            .expect("the read runs")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    async fn current(&self) -> Vec<ProviderAccountId> {
        self.accounts
            .list(Some(first_provider()))
            .await
            .expect("the accounts list")
            .into_iter()
            .filter(|account| account.is_default)
            .map(|account| account.account_id)
            .collect()
    }
}

fn refusal_code(error: HandlerError) -> RefusalCode {
    match error {
        HandlerError::Refused(refusal) => refusal.code,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("the switch failed otherwise: {other}")
        }
    }
}

#[derive(Clone, Copy)]
enum DeadTarget {
    Unregistered,
    HomeGone,
    SignInGone,
}

// A target that cannot be realized is refused before the mark moves or any session is sent a
// move, each with its own code. Killed by a refusal checked after the mark moved (the current
// account reads the target) or after the moves (the legs record a call), and by the dead-login
// check dropped.
#[rstest]
#[case::unregistered(DeadTarget::Unregistered, RefusalCode::ProviderAccountNotFound)]
#[case::home_gone(
    DeadTarget::HomeGone,
    RefusalCode::ProviderAccountCredentialHomeUnavailable
)]
#[case::sign_in_gone(DeadTarget::SignInGone, RefusalCode::ProviderAccountNotAuthenticated)]
#[tokio::test]
async fn a_dead_switch_target_is_refused_before_anything_moves(
    #[case] target: DeadTarget,
    #[case] code: RefusalCode,
) {
    let fixture = fixture().await;
    let current = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    fixture
        .session(PROVIDERS[0].id, &current, PermissionLevel::Ask, true)
        .await;
    let target = match target {
        DeadTarget::Unregistered => {
            ProviderAccountId::new("never-registered".to_owned()).expect("an account id")
        }
        DeadTarget::HomeGone => {
            let target = fixture
                .register(ProviderAccountHealthState::Authenticated)
                .await;
            let home = fixture
                .accounts
                .read(target.clone())
                .await
                .expect("the target reads")
                .credential_home;
            std::fs::remove_dir_all(home.path()).expect("the test removes the home");
            target
        }
        DeadTarget::SignInGone => {
            fixture
                .register(ProviderAccountHealthState::ReauthRequired)
                .await
        }
    };

    let refused = fixture.switch.make_current(target, actor()).await;

    let Err(error) = refused else {
        panic!("the dead target was made current");
    };
    assert_eq!(refusal_code(error), code);
    assert_eq!(fixture.current().await, [current]);
    assert!(
        lock(&fixture.legs.calls).is_empty(),
        "a session was sent a move"
    );
}

// One switch moves every running session of the provider not on the target through its legs,
// from the account each leaves, and settles each lead once: in place where it landed, failed
// `accountUnavailable` where the provider refused it or handed the old account back, the others
// still moving. A session at `reviewed` whose new account's model lists no `reviewed` moves to
// `ask` through the level control once, with one `levelUnavailable` naming the level it left. A
// session that never ran lands at once with no leg call, and one already on the target or on
// another provider gets nothing. Killed by the notice dropped, by the level control skipped, by a
// refused move dropping the others, by a hand-back settled as a success, and by a session on
// another provider or on the target moved.
#[tokio::test]
async fn a_switch_moves_each_session_off_the_target_and_settles_each_lead_once() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let reviewed = fixture
        .session(PROVIDERS[0].id, &old, PermissionLevel::Reviewed, true)
        .await;
    let refused = fixture
        .session(PROVIDERS[0].id, &old, PermissionLevel::Ask, true)
        .await;
    let handed_back = fixture
        .session(PROVIDERS[0].id, &old, PermissionLevel::Ask, true)
        .await;
    let never_ran = fixture
        .session(PROVIDERS[0].id, &old, PermissionLevel::Ask, false)
        .await;
    let on_target = fixture
        .session(PROVIDERS[0].id, &to, PermissionLevel::Reviewed, true)
        .await;
    let elsewhere = fixture
        .session(PROVIDERS[1].id, &old, PermissionLevel::Reviewed, true)
        .await;
    lock(&fixture.legs.script).extend([
        (refused, ScriptedMove::Refused),
        (
            handed_back,
            ScriptedMove::Lands(FirstRequestAfterMove::HandedBack),
        ),
    ]);

    let made = fixture
        .switch
        .make_current(to.clone(), actor())
        .await
        .expect("the switch is made");
    made.settled.await.expect("the moves settle");

    assert_eq!(made.account.account_id, to);
    assert_eq!(
        made.left.map(|left| (left.account_id, left.is_default)),
        Some((old.clone(), false))
    );
    let mut moving = made.moving_sessions;
    moving.sort_by_key(|session| session.text().as_str().to_owned());
    let mut expected = vec![reviewed, refused, handed_back, never_ran];
    expected.sort_by_key(|session| session.text().as_str().to_owned());
    assert_eq!(moving, expected);
    assert_eq!(fixture.current().await, std::slice::from_ref(&to));

    let calls = lock(&fixture.legs.calls).clone();
    assert_eq!(calls.len(), 1, "one call for the one account left");
    let (from, called_to, sessions) = &calls[0];
    assert_eq!((from, called_to), (&old, &to));
    let mut sent: Vec<SessionId> = sessions.iter().map(|session| session.session_id).collect();
    sent.sort_by_key(|session| session.text().as_str().to_owned());
    let mut with_runs = vec![reviewed, refused, handed_back];
    with_runs.sort_by_key(|session| session.text().as_str().to_owned());
    assert_eq!(sent, with_runs);

    assert_eq!(
        *lock(&fixture.level_moves.0),
        [(reviewed, PermissionLevel::Ask)]
    );
    let reviewed_events = fixture.appended(reviewed);
    let kinds: Vec<&str> = reviewed_events
        .iter()
        .map(|(kind, _)| kind.as_str())
        .collect();
    assert_eq!(
        kinds,
        ["session.notice.posted", "agent.providerBinding.changed"]
    );
    assert_eq!(reviewed_events[0].1["kind"], "levelUnavailable");
    assert_eq!(reviewed_events[0].1["level"], "reviewed");
    let changed = &reviewed_events[1].1;
    assert_eq!(changed["continuity"], "inPlace");
    assert_eq!(changed["landedProviderAccountId"], to.as_str());
    assert_eq!(changed["to"]["providerAccountId"], Value::Null);
    assert_eq!(changed["from"]["providerAccountId"], old.as_str());

    for (session, account_state) in [(refused, "reauthRequired"), (handed_back, "reauthRequired")] {
        let events = fixture.appended(session);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "agent.providerBinding.changeFailed");
        assert_eq!(events[0].1["reason"], "accountUnavailable");
        assert_eq!(events[0].1["accountState"], account_state);
        assert_eq!(events[0].1["attempted"]["providerAccountId"], to.as_str());
    }
    let never_ran_events = fixture.appended(never_ran);
    assert_eq!(never_ran_events.len(), 1);
    assert_eq!(never_ran_events[0].0, "agent.providerBinding.changed");
    assert_eq!(fixture.appended(on_target), Vec::new());
    assert_eq!(fixture.appended(elsewhere), Vec::new());
}

// A session the last stop left on an account that is no longer its provider's current one moves
// onto the current one at the start, before its next request, settled in place. Killed by the
// start's move dropped, and by its leg called on the current account as the one left.
#[tokio::test]
async fn a_session_a_stop_left_on_the_old_account_moves_at_the_start() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let current = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let left_behind = fixture
        .session(PROVIDERS[0].id, &old, PermissionLevel::Ask, true)
        .await;
    fixture
        .accounts
        .make_current(current.clone())
        .await
        .expect("the mark moves while the daemon is down");

    fixture
        .switch
        .follow_current_accounts(actor())
        .await
        .expect("the start's move settles");

    let calls = lock(&fixture.legs.calls).clone();
    assert_eq!(calls.len(), 1);
    assert_eq!((&calls[0].0, &calls[0].1), (&old, &current));
    assert_eq!(calls[0].2[0].session_id, left_behind);
    let events = fixture.appended(left_behind);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "agent.providerBinding.changed");
    assert_eq!(events[0].1["landedProviderAccountId"], current.as_str());
}
