use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use serde_json::json;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::UsageRateLimitUpdatedPayload;
use sidekicks_contracts::provider::account::methods::ProviderAccountList;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountId, ProviderAccountListRequest,
    ProviderAccountNotification,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, SafeSignedInt};
use sidekicks_contracts::wire::number::{NonNegativeNumber, Number};
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, create_missing_private_folders};
use sidekicks_provider::account::credential_home::ACCOUNT_SIGN_OUT_BOUND;
use sidekicks_provider::account::credential_home::test_legs::RecordedSignOuts;
use sidekicks_provider::account::observer::AccountTurnObserver;
use sidekicks_provider::account::registry::{
    PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY, open_test_registry,
};
use sidekicks_provider::account::sign_in::ProviderAccountNotificationPublisher;
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, open_database,
};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope};
use sidekicks_store::events::session::followers::CommittedEvent;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use super::TestHome;
use crate::daemon::process::provider_accounts::{
    collect_provider_account_legs, follow_usage_event, publish_usage_window,
    start_minted_home_sweep,
};
use crate::daemon::process::stop::{DaemonStopFailure, DaemonStopReason, end_start_tasks};
use crate::daemon::schema::schema_parts;

// The stored account's id.
const ACCOUNT_ID: &str = "0123456789abcdef0123456789abcdef";

// The longest a test waits on the start's sweep of new accounts' homes, well within one sign-out's
// bound.
const SWEEP_WAIT: Duration = Duration::from_secs(10);

// The account a client lists is the row the registry holds: `provider.account.list`, called
// through the typed client against the daemon's served table, answers the stored account. Killed by
// the provider account table left unregistered, where the call is refused as an unknown method.
#[tokio::test(flavor = "multi_thread")]
async fn a_client_lists_the_provider_accounts_the_registry_holds() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let data_folder = home.data_folder();
    create_missing_private_folders(&data_folder).expect("the data folder is made");
    let account_home = data_folder.join("account-home");
    std::fs::create_dir(&account_home).expect("the account's home is made");
    let connection = open_database(
        &data_folder.join(DAEMON_DATABASE_FILE_NAME),
        &schema_parts().into_schema(),
    )
    .expect("the store opens");
    let now = WireInstant::now();
    connection
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, is_default, created_at, updated_at)
             VALUES (?1, 'codex', ?2, 'unknown', 1, ?3, ?3)",
            params![
                ACCOUNT_ID,
                account_home.to_str().expect("the home's path is text"),
                now.as_str(),
            ],
        )
        .expect("the account is stored");
    drop(connection);
    let daemon = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");

    let client = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the handshake completes");
    let listed = client
        .client()
        .call::<ProviderAccountList>(&ProviderAccountListRequest {
            provider: None,
            account_id: None,
        })
        .await;
    client.close().await;
    daemon
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the daemon's stop fails nothing");

    let listed = listed.expect("the list answers");
    let account_ids: Vec<&str> = listed
        .accounts
        .iter()
        .map(|account| account.account_id().as_str())
        .collect();
    assert_eq!(account_ids, [ACCOUNT_ID]);
}

// A start with two homes a stop left minted for new accounts goes on while their sign-outs hang,
// the two sign-outs run at once, and the stop ends the sweep still running at its bound. Killed by
// the sweep awaited on the start's path (the start outlasts its wait), by the sign-outs run one
// after another (the second has not begun within the wait) and by a stop that waits for the sweep
// past its bound (it answers no failure once the sign-outs overrun theirs).
#[tokio::test]
async fn a_start_goes_on_while_the_sign_outs_of_new_accounts_homes_hang() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let claude = ProviderId::new("claude".to_owned()).expect("a provider id");
    for _ in 0..2 {
        registry
            .mint(claude.clone())
            .expect("a new account is minted");
    }
    let legs = Arc::new(RecordedSignOuts::hanging());

    let sweep = tokio::time::timeout(
        SWEEP_WAIT,
        start_minted_home_sweep(
            &registry,
            &HashMap::from([(claude, Arc::clone(&legs) as Arc<dyn ProviderAccountLegs>)]),
            data_folder.path().to_path_buf(),
            ACCOUNT_SIGN_OUT_BOUND,
        ),
    )
    .await
    .expect("the start goes on while the sign-outs hang");
    tokio::time::timeout(SWEEP_WAIT, async {
        while legs.signed_out().len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both sign-outs run at once");
    let failures = end_start_tasks([("sweep", sweep)], Duration::ZERO).await;

    assert!(matches!(
        failures.as_slice(),
        [DaemonStopFailure::StartTaskRunning("sweep")]
    ));
}

// The plane takes every act the drivers' account legs offer: over the real drivers, each
// provider's window turns, sign-in and pasted-token status read. Killed by the window-turn, the
// sign-in or the token-status arm dropped from the collection.
#[tokio::test]
async fn the_plane_collects_each_act_the_real_drivers_offer() {
    let providers =
        ProviderRegistry::register_from(PROVIDER_REGISTRATIONS, &test_driver_services());
    let claude = ProviderId::new("claude".to_owned()).expect("a provider id");
    let codex = ProviderId::new("codex".to_owned()).expect("a provider id");
    let both = HashSet::from([claude, codex]);

    let legs = collect_provider_account_legs(&providers);

    assert_eq!(
        legs.window_turn.keys().cloned().collect::<HashSet<_>>(),
        both
    );
    assert_eq!(legs.sign_in.keys().cloned().collect::<HashSet<_>>(), both);
    assert_eq!(
        legs.token_status.keys().cloned().collect::<HashSet<_>>(),
        both
    );
}

// Each notification published, in order.
#[derive(Default)]
struct RecordedNotifications(Mutex<Vec<ProviderAccountNotification>>);

impl ProviderAccountNotificationPublisher for RecordedNotifications {
    fn publish(&self, notification: ProviderAccountNotification) {
        lock(&self.0).push(notification);
    }
}

// The five-hour `session` reading of the stored account, `window_mins` long.
fn session_reading(window_mins: i64) -> UsageRateLimitUpdatedPayload {
    UsageRateLimitUpdatedPayload {
        provider: ProviderId::new("codex".to_owned()).expect("a provider id"),
        provider_account_id: ProviderAccountId::new(ACCOUNT_ID.to_owned()).expect("an account id"),
        credential_generation: CredentialGeneration::new(1).expect("a generation"),
        limit_id: Some(BoundedText::new("session".to_owned()).expect("a limit id")),
        window_mins: Some(SafeSignedInt::new(window_mins).expect("a window length")),
        label: None,
        used_percent: Number::new(40.0).expect("a share"),
        resets_at: None,
        whole_set: None,
    }
}

// A quota reading goes out as the window the projection keeps for its account, limit and length,
// and a reading the projection keeps no row for publishes nothing. Killed by the publish dropped,
// and by a window of another length published in the reading's place.
#[tokio::test]
async fn a_quota_reading_publishes_the_window_the_projection_keeps() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let database_path = data_folder.path().join(DAEMON_DATABASE_FILE_NAME);
    let connection =
        open_database(&database_path, &schema_parts().into_schema()).expect("the store opens");
    let now = WireInstant::now();
    connection
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, is_default, created_at, updated_at)
             VALUES (?1, 'codex', '/accounts/1', 'unknown', 1, ?2, ?2)",
            params![ACCOUNT_ID, now.as_str()],
        )
        .expect("the account is stored");
    for (window_mins, used_percent) in [(10_080, 5.0), (300, 40.0)] {
        connection
            .execute(
                "INSERT INTO provider_account_usage_windows (account_id, limit_id, window_mins,
                   used_percent, observed_at, observed_credential_generation, source)
                 VALUES (?1, 'session', ?2, ?3, ?4, 1, 'run')",
                params![ACCOUNT_ID, window_mins, used_percent, now.as_str()],
            )
            .expect("the window is stored");
    }
    drop(connection);
    let reads = DatabaseReadPool::new(database_path, PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY);
    let published = RecordedNotifications::default();

    publish_usage_window(&reads, &published, &session_reading(300))
        .await
        .expect("the reading is published");
    publish_usage_window(&reads, &published, &session_reading(60))
        .await
        .expect("a reading with no row publishes nothing");

    let published = lock(&published.0).clone();
    let [ProviderAccountNotification::UsageWindowUpdated { account_id, window }] =
        published.as_slice()
    else {
        panic!("one window is published, not {published:?}");
    };
    assert_eq!(account_id.as_str(), ACCOUNT_ID);
    assert_eq!(window.window_mins, SafeInt::new(300));
    assert_eq!(
        window.used_percent,
        NonNegativeNumber::new(40.0).expect("a share")
    );
}

// Each turn-end hand the observer was given: an account's turn ended, or a run closed.
#[derive(Default)]
struct RecordedTurnEnds {
    ended: Mutex<Vec<ProviderAccountId>>,
    closed: Mutex<usize>,
}

impl AccountTurnObserver for RecordedTurnEnds {
    fn turn_ended(&self, provider_account_id: ProviderAccountId) {
        lock(&self.ended).push(provider_account_id);
    }

    fn turn_closed(&self) {
        *lock(&self.closed) += 1;
    }
}

// A run's terminal state, followed as the observation follows every committed event, reaches the
// observer as a run closed, which asks again each turn-end read a live turn turned away. Killed by
// the follow's turn-end hand removed, where those reads stay owed until another turn on the
// account ends.
#[tokio::test]
async fn a_run_end_hands_the_observer_a_closed_run() {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let event: SessionEvent = serde_json::from_value(json!({
        "type": SessionEventType::AgentRunCompleted.as_str(),
        "payload": {
            "sessionId": session_id,
            "runId": mint_uuid_v7().to_string(),
            "runVersion": 2,
            "previousState": "running",
            "newState": "completed",
        },
    }))
    .expect("the test writes a session event");
    let observer = RecordedTurnEnds::default();
    let data_folder = tempfile::tempdir().expect("a data folder");
    // Never opened: a run's end reads nothing.
    let reads = Arc::new(DatabaseReadPool::new(
        data_folder.path().join(DAEMON_DATABASE_FILE_NAME),
        PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    ));
    let publisher: Arc<dyn ProviderAccountNotificationPublisher> =
        Arc::new(RecordedNotifications::default());

    follow_usage_event(
        &observer,
        &reads,
        &publisher,
        &CommittedEvent {
            envelope: Arc::new(test_envelope(session_id, &event)),
            sequence: SafeInt::new(1).expect("a sequence"),
        },
        &Handle::current(),
    )
    .expect("the run's end reads");

    assert_eq!(*lock(&observer.closed), 1);
    assert_eq!(*lock(&observer.ended), []);
}
