//! The current-account switch over a test database, the real account registry and folder reader,
//! a driver whose level list the test names, and switch legs and a level control that record what
//! they were asked and answer as the test scripts; beside it, the record of a move no switch waits
//! on, landing through the same switch.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use sidekicks_provider::account::sign_in::AccountsInFlight;
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
use sidekicks_session::run::engine::test_fixture::insert_run;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{AccountSwitch, AccountSwitchDeps, SessionAccountMoveRecord, SessionLevelMoves};
use crate::daemon::schema::schema_parts;

mod landing;

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

// How a scripted move of one session goes: it lands and its first request reads as given, it lands
// and the hand-back its first request asks for cannot be made, it lands and its first request never
// comes, or the provider refuses it.
#[derive(Clone, Copy)]
enum ScriptedMove {
    Lands(FirstRequestAfterMove),
    HandBackFails,
    FirstRequestNeverComes,
    Refused,
}

fn refused_login() -> DriverError {
    DriverError::from(DomainError::new(
        "The provider refused the login",
        RefusalCode::ProviderAccountNotAuthenticated,
    ))
}

// Switch legs recording each call, and whether its target was in flight while it ran, and
// answering each session as scripted once a gate the test set, if any, opens; a session not
// scripted lands with its first request run.
#[derive(Default)]
struct RecordedSwitchLegs {
    script: Mutex<HashMap<SessionId, ScriptedMove>>,
    calls: Mutex<Vec<(ProviderAccountId, ProviderAccountId, Vec<SessionToMove>)>>,
    accounts_in_flight: Arc<AccountsInFlight>,
    is_target_in_flight: Mutex<Vec<bool>>,
    gate: Mutex<Option<oneshot::Receiver<()>>>,
}

impl ProviderSwitchLegs for RecordedSwitchLegs {
    fn move_sessions(
        &self,
        from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
        _actor: DeviceId,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>> {
        lock(&self.is_target_in_flight).push(self.accounts_in_flight.is_in_flight(&to));
        lock(&self.calls).push((from, to, sessions.clone()));
        let script = lock(&self.script).clone();
        let gate = lock(&self.gate).take();
        async move {
            if let Some(gate) = gate {
                gate.await.expect("the test opens the gate");
            }
            sessions
                .into_iter()
                .map(|session| {
                    let scripted = script
                        .get(&session.session_id)
                        .copied()
                        .unwrap_or(ScriptedMove::Lands(FirstRequestAfterMove::Ran));
                    let first_request = match scripted {
                        ScriptedMove::Lands(first) => futures::future::ready(Ok(first)).boxed(),
                        ScriptedMove::HandBackFails => {
                            futures::future::ready(Err(refused_login())).boxed()
                        }
                        ScriptedMove::FirstRequestNeverComes => futures::future::pending().boxed(),
                        ScriptedMove::Refused => {
                            return Err((session.session_id, refused_login()));
                        }
                    };
                    Ok(SessionAccountMove {
                        session_id: session.session_id,
                        first_request,
                    })
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
    bindings: Arc<RuntimeBindingStore>,
    legs: Arc<RecordedSwitchLegs>,
    level_moves: Arc<RecordedLevelMoves>,
    accounts_in_flight: Arc<AccountsInFlight>,
    switch: Arc<AccountSwitch>,
    move_record: SessionAccountMoveRecord,
    machine_device_id: DeviceId,
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
    let accounts_in_flight = Arc::new(AccountsInFlight::default());
    let legs = Arc::new(RecordedSwitchLegs {
        accounts_in_flight: Arc::clone(&accounts_in_flight),
        ..RecordedSwitchLegs::default()
    });
    let level_moves = Arc::new(RecordedLevelMoves::default());
    let appender = Arc::new(SessionEventAppender::new(
        Arc::clone(&log.service),
        SESSION_EVENT_VERSION.clone(),
    ));
    let machine_device_id = actor();
    let bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&reads),
        Arc::clone(&log.writer),
    ));
    let switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
        accounts: Arc::clone(&accounts),
        accounts_in_flight: Arc::clone(&accounts_in_flight),
        account_reader: Arc::new(ProviderAccounts::new(
            Arc::clone(&reads),
            Arc::new(NoTokens),
            accounts.observed_auth_modes(),
        )),
        switch_legs: HashMap::from([(
            first_provider(),
            Arc::clone(&legs) as Arc<dyn ProviderSwitchLegs>,
        )]),
        providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
        level_moves: Arc::clone(&level_moves) as Arc<dyn SessionLevelMoves>,
        bindings: Arc::clone(&bindings) as _,
        appender,
        reads: Arc::clone(&reads),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None::<i64>),
    }));
    let move_record = SessionAccountMoveRecord::new(&switch, machine_device_id.clone());
    Fixture {
        database,
        _log: log,
        _data_folder: data_folder,
        accounts,
        bindings,
        legs,
        level_moves,
        accounts_in_flight,
        switch,
        move_record,
        machine_device_id,
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

    // An active session whose lead runs on `provider`, pinned to `pin` or following the current
    // account, at `level`, with a binding of a run of its on `runs_on` where `has_run`.
    async fn session(
        &self,
        provider: &str,
        runs_on: &ProviderAccountId,
        pin: Option<&ProviderAccountId>,
        level: PermissionLevel,
        has_run: bool,
    ) -> SessionId {
        let lead = json!({
            "agentId": mint_uuid_v7().to_string(),
            "binding": {
                "providerName": provider,
                "modelId": "model-1",
                "effort": null,
                "providerAccountId": pin.map(ProviderAccountId::as_str),
            },
        });
        self.session_led_by(lead, runs_on, level, has_run).await
    }

    // An active session whose log names `lead` as its lead, at `level`, with a binding of a run of
    // its on `runs_on` where `has_run`.
    async fn session_led_by(
        &self,
        lead: Value,
        runs_on: &ProviderAccountId,
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
                    json!({ "mainAgent": lead }).to_string(),
                ],
            )
            .expect("the test creates the session's lead");
        drop(connection);
        if has_run {
            let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
            insert_run(&self.database, session_id, run_id, "running");
            self.bindings
                .create(CreateRuntimeBindingInput {
                    run_id,
                    ..binding_input(
                        spawn_config_on(runs_on.clone()),
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
        .session(PROVIDERS[0].id, &current, None, PermissionLevel::Ask, true)
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

// One switch moves every session of the provider that follows the current account and runs on
// another through its legs, from the account each leaves, and settles each lead at its
// acknowledgment: in place where it landed, failed `accountUnavailable` where the provider refused
// it, the others still moving, and one more failed settlement where its first request on the new
// account handed the old one back, or asked for a hand-back that could not be made. A session at
// `reviewed` whose new account's model lists no `reviewed` moves to `ask` through the level control
// once, then one `levelUnavailable` names the level it left. A session that never ran, one already
// on the target and one on another provider get nothing. Killed by the notice dropped, by the level
// control skipped, by a refused move dropping the others, by the settlement held until the first
// request (the hand-back then records no `changed`), by a hand-back settled as a success, by a
// hand-back that could not be made only logged, and by a session never run, on another provider
// or on the target moved.
#[tokio::test]
async fn a_switch_moves_each_session_off_the_target_and_settles_each_lead_at_its_acknowledgment() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let follower = |level, has_run| fixture.session(PROVIDERS[0].id, &old, None, level, has_run);
    let reviewed = follower(PermissionLevel::Reviewed, true).await;
    let refused = follower(PermissionLevel::Ask, true).await;
    let handed_back = follower(PermissionLevel::Ask, true).await;
    let hand_back_failed = follower(PermissionLevel::Ask, true).await;
    let never_ran = follower(PermissionLevel::Ask, false).await;
    let on_target = fixture
        .session(PROVIDERS[0].id, &to, None, PermissionLevel::Reviewed, true)
        .await;
    let elsewhere = fixture
        .session(PROVIDERS[1].id, &old, None, PermissionLevel::Reviewed, true)
        .await;
    lock(&fixture.legs.script).extend([
        (refused, ScriptedMove::Refused),
        (
            handed_back,
            ScriptedMove::Lands(FirstRequestAfterMove::HandedBack),
        ),
        (hand_back_failed, ScriptedMove::HandBackFails),
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
    let mut moved = vec![reviewed, refused, handed_back, hand_back_failed];
    moved.sort_by_key(|session| session.text().as_str().to_owned());
    let mut moving = made.moving_sessions;
    moving.sort_by_key(|session| session.text().as_str().to_owned());
    assert_eq!(moving, moved);
    assert_eq!(fixture.current().await, std::slice::from_ref(&to));

    let calls = lock(&fixture.legs.calls).clone();
    assert_eq!(calls.len(), 1, "one call for the one account left");
    let (from, called_to, sessions) = &calls[0];
    assert_eq!((from, called_to), (&old, &to));
    let mut sent: Vec<SessionId> = sessions.iter().map(|session| session.session_id).collect();
    sent.sort_by_key(|session| session.text().as_str().to_owned());
    assert_eq!(sent, moved);

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
        ["agent.providerBinding.changed", "session.notice.posted"]
    );
    let changed = &reviewed_events[0].1;
    assert_eq!(changed["continuity"], "inPlace");
    assert_eq!(changed["landedProviderAccountId"], to.as_str());
    assert_eq!(changed["from"]["providerAccountId"], Value::Null);
    assert_eq!(changed["to"]["providerAccountId"], Value::Null);
    assert_eq!(reviewed_events[1].1["kind"], "levelUnavailable");
    assert_eq!(reviewed_events[1].1["level"], "reviewed");

    let refused_events = fixture.appended(refused);
    let handed_back_events = fixture.appended(handed_back);
    let hand_back_failed_events = fixture.appended(hand_back_failed);
    for events in [&handed_back_events, &hand_back_failed_events] {
        let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "agent.providerBinding.changed",
                "agent.providerBinding.changeFailed"
            ]
        );
    }
    assert_eq!(refused_events.len(), 1);
    for failed in [
        &refused_events[0],
        &handed_back_events[1],
        &hand_back_failed_events[1],
    ] {
        assert_eq!(failed.0, "agent.providerBinding.changeFailed");
        assert_eq!(failed.1["reason"], "accountUnavailable");
        assert_eq!(failed.1["accountState"], "reauthRequired");
        assert_eq!(failed.1["attempted"]["providerAccountId"], to.as_str());
    }
    for untouched in [never_ran, on_target, elsewhere] {
        assert_eq!(fixture.appended(untouched), Vec::new());
    }
}

// A session pinned to the account the mark leaves keeps running on it through a switch: no move,
// no settlement. Killed by the pin filter dropped from the sessions' read.
#[tokio::test]
async fn a_pinned_session_gets_nothing_from_a_switch() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let pinned = fixture
        .session(
            PROVIDERS[0].id,
            &old,
            Some(&old),
            PermissionLevel::Ask,
            true,
        )
        .await;

    let made = fixture
        .switch
        .make_current(to, actor())
        .await
        .expect("the switch is made");
    made.settled.await.expect("the moves settle");

    assert_eq!(made.moving_sessions, Vec::new());
    assert!(
        lock(&fixture.legs.calls).is_empty(),
        "the pinned session was sent a move"
    );
    assert_eq!(fixture.appended(pinned), Vec::new());
}

// A switch to the account already current moves a session a failed move left on another one,
// the mark staying where it is. Killed by a switch that plans against the mark and moves nothing
// when the target already holds it.
#[tokio::test]
async fn a_switch_to_the_current_account_moves_a_session_left_on_another() {
    let fixture = fixture().await;
    let current = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let other = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let left_behind = fixture
        .session(PROVIDERS[0].id, &other, None, PermissionLevel::Ask, true)
        .await;

    let made = fixture
        .switch
        .make_current(current.clone(), actor())
        .await
        .expect("the switch is made");
    made.settled.await.expect("the moves settle");

    assert_eq!(made.left.map(|left| left.account_id), None);
    assert_eq!(made.moving_sessions, [left_behind]);
    assert_eq!(fixture.current().await, std::slice::from_ref(&current));
    let calls = lock(&fixture.legs.calls).clone();
    assert_eq!(calls.len(), 1);
    assert_eq!((&calls[0].0, &calls[0].1), (&other, &current));
    let events = fixture.appended(left_behind);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].1["landedProviderAccountId"], current.as_str());
}

// A session the last stop left on an account that is no longer its provider's current one moves
// onto the current one at the start, settled in place, though its first request on that account
// has not come and a session beside it has a lead that does not read. Killed by the start's move
// dropped, by its leg called on the current account as the one left, by the start waiting on the
// first request (it never ends), and by one unreadable session failing the start.
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
        .session(PROVIDERS[0].id, &old, None, PermissionLevel::Ask, true)
        .await;
    let unreadable = json!({
        "agentId": "not-an-agent-id",
        "binding": { "providerName": PROVIDERS[0].id, "modelId": "model-1", "effort": null },
    });
    fixture
        .session_led_by(unreadable, &old, PermissionLevel::Ask, true)
        .await;
    lock(&fixture.legs.script).insert(left_behind, ScriptedMove::FirstRequestNeverComes);
    fixture
        .accounts
        .make_current(current.clone())
        .await
        .expect("the mark moves while the daemon is down");

    tokio::time::timeout(
        Duration::from_secs(10),
        fixture.switch.follow_current_accounts(&actor()),
    )
    .await
    .expect("the start does not wait on the first request")
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

// A switch holds its account in flight from its refusals until every move has landed, so no
// sign-in or reset starts in the home meanwhile, and lets it go with the provider's lock, before
// any moved lead's first request comes: a second switch onto the account, waiting on that lock
// while the first lands, is made, and a sign-in that took the account first refuses a switch.
// Killed by the account only checked, not put in flight (the move finds it free), by it kept until
// the first requests settle (the second switch is refused, the first request never coming), and by
// it let go after the lock, as a race between worker threads that a run may not catch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switch_holds_its_account_in_flight_until_every_move_has_landed() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let session = fixture
        .session(PROVIDERS[0].id, &old, None, PermissionLevel::Ask, true)
        .await;
    lock(&fixture.legs.script).insert(session, ScriptedMove::FirstRequestNeverComes);
    let (open_gate, gate) = oneshot::channel();
    *lock(&fixture.legs.gate) = Some(gate);

    fixture
        .switch
        .make_current(to.clone(), actor())
        .await
        .expect("the switch is made");
    let holder_handles = fixture.switch.locks.queue_handle_count(first_provider());
    let second_switch = Arc::clone(&fixture.switch);
    let second_to = to.clone();
    let second = tokio::spawn(async move { second_switch.make_current(second_to, actor()).await });
    fixture
        .switch
        .locks
        .wait_for_queue_past(first_provider(), holder_handles)
        .await;
    open_gate.send(()).expect("the first switch's move waits");
    let second = second.await.expect("the second switch's caller ends");
    // Held once both switches have let it go, each letting the account go first.
    drop(fixture.switch.locks.acquire(first_provider()).await);
    let is_to_in_flight = fixture.accounts_in_flight.is_in_flight(&to);
    let _in_flight_guard = fixture
        .accounts_in_flight
        .begin(old.clone())
        .expect("no act holds the account left");
    let refused = fixture.switch.make_current(old, actor()).await;

    assert!(second.is_ok(), "a second switch onto the account is made");
    // Each move found its target in flight, the second switch's too where it moved the session.
    let target_in_flight = lock(&fixture.legs.is_target_in_flight).clone();
    assert!(target_in_flight.first() == Some(&true) && !target_in_flight.contains(&false));
    assert!(!is_to_in_flight);
    let Err(error) = refused else {
        panic!("an account signing in was made current");
    };
    assert_eq!(
        refusal_code(error),
        RefusalCode::ProviderAccountSignInInFlight
    );
}
