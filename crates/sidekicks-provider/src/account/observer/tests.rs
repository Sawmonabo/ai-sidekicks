use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::StreamExt as _;
use futures::channel::mpsc;
use rstest::rstest;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountHealthState, ProviderAccountNotification,
    ProviderSignInOutcome,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountSignInRequest, RegisteredAccountSignIn,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::WallClock as _;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::runtime::Handle;
use tokio::sync::{Notify, Semaphore};

use super::test_fixture::{Fixture, ScriptedLegs, claude, figures, new_clock, read_reading};
use super::window_store::read_usage_windows;
use super::{AccountReadAnswer, AccountTurnObserver as _, ProviderAccountObserver, ReadAsker};
use crate::account::registry::{HealthObservation, HealthObserver};
use crate::account::sign_in::ProviderSignInBroker;
use crate::account::sign_in::tests::{
    RecordingWatcher, ScriptedLegs as ScriptedSignIns, Status as SignInStatus,
};
use crate::driver::contract::account::{
    ObservedAccountIdentity, ProviderAccountFigures, ProviderObservation, ProviderSignInEnd,
    ProviderSignInLegs, SignInOrigin,
};
use crate::driver::schema::schema_parts;

fn generation(value: u64) -> CredentialGeneration {
    serde_json::from_value(value.into()).expect("a test generation")
}

// What the account's stored health is after the reads.
#[derive(Clone, Copy, Debug)]
enum Stored {
    // The registration's observation, untouched.
    Unchanged,
    // This state, observed at the last read.
    AtLastRead(ProviderAccountHealthState),
}

// Cadence reads, each a hold's length past the last: what each answer stores as the health, where
// the ladder stands and that no background write moves the generation. Killed by a refused or
// unanswered read stored as a reading (the health reads signed in at the read's time), by the
// ladder not climbing or not cleared, by a login gone held on the ladder, by `indeterminate` at
// the first refusal or never, by a background write that moves the generation, and by a read
// that rewrote the row not published as the account it now is, or one that wrote nothing
// published.
#[rstest]
#[case::figures_clear_the_ladder(
    vec![Some(ProviderObservation::RefusedInBand), Some(ProviderObservation::Figures(figures()))],
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
async fn each_answer_stores_its_health_and_ladder_place_and_never_moves_the_generation(
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
    let published = match stored {
        Stored::Unchanged => Vec::new(),
        Stored::AtLastRead(_) => vec![ProviderAccountNotification::AccountChanged {
            account: read.to_provider_account(),
        }],
    };
    assert_eq!(fixture.notifications.published(), published);
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

    fixture.live_turns.is_live.store(true, Ordering::SeqCst);
    assert_eq!(fixture.read(&account, ReadAsker::CheckNow).await, not_yet);
    assert_eq!(fixture.read(&account, ReadAsker::Cadence).await, not_yet);
    fixture.live_turns.is_live.store(false, Ordering::SeqCst);

    // A sign-in holds the account's home while its flow starts and while its end is stored.
    let sign_in = fixture.home_lock.hold(account.account_id.clone()).await;
    assert_eq!(fixture.read(&account, ReadAsker::CheckNow).await, not_yet);
    assert_eq!(fixture.read(&account, ReadAsker::Dictation).await, not_yet);
    assert_eq!(fixture.legs.reads(), 0);
    drop(sign_in);

    read_reading(fixture.read(&account, ReadAsker::CheckNow).await);
    assert_eq!(fixture.legs.reads(), 1);
}

// A probe asked while a sign-in is in flight on a signed-out account reads nothing and writes
// nothing, so the sign-in's save finds the generation it started on and stores the account signed
// in; the account's next read runs. Killed by the sign-in check dropped, where the probe reads the
// account signed in, a crossing that moves its generation, and the sign-in fails at its save.
#[tokio::test]
async fn a_probe_during_a_sign_in_writes_nothing_and_the_sign_in_saves() {
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
    let account_id = account.account_id.clone();
    fixture
        .registry
        .record_health(
            &account_id,
            &HealthObservation {
                state: ProviderAccountHealthState::ReauthRequired,
                observed_at: WireInstant::now(),
            },
            HealthObserver::Probe,
        )
        .await
        .expect("the account reads signed out");
    let (flow_sender, mut flows) = mpsc::unbounded();
    let broker = ProviderSignInBroker::new(
        Arc::clone(&fixture.registry),
        HashMap::from([(
            claude(),
            Arc::new(ScriptedSignIns {
                status: SignInStatus::Read {
                    is_account_named: true,
                },
                flows: flow_sender,
                homes: Mutex::default(),
                holds_machine_slot: false,
            }) as Arc<dyn ProviderSignInLegs>,
        )]),
        Arc::clone(&fixture.notifications) as _,
        Arc::new(RecordingWatcher::default()),
        Arc::clone(&fixture.home_lock),
        Arc::clone(&fixture.accounts_in_flight),
    );
    broker
        .start(
            ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
                account_id: account_id.clone(),
            }),
            SignInOrigin::ThisMachine,
        )
        .await
        .expect("the sign-in starts");
    let flow = flows.next().await.expect("the flow started");
    let started = fixture
        .registry
        .read(account_id.clone())
        .await
        .expect("the account reads");

    assert_eq!(
        fixture.read(&account, ReadAsker::CheckNow).await,
        AccountReadAnswer::NotNow { last: None }
    );
    assert_eq!(fixture.legs.reads(), 0);
    let during = fixture
        .registry
        .read(account_id.clone())
        .await
        .expect("the account reads");
    assert_eq!(during.credential_generation, started.credential_generation);

    flow.finish(ProviderSignInEnd::Finished);
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let ended = fixture
                .notifications
                .published()
                .into_iter()
                .find_map(|notification| {
                    if let ProviderAccountNotification::SignInCompleted { outcome, .. } =
                        notification
                    {
                        Some(outcome)
                    } else {
                        None
                    }
                });
            if let Some(outcome) = ended {
                return outcome;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the sign-in settles");
    assert_eq!(outcome, ProviderSignInOutcome::Succeeded);
    read_reading(fixture.read(&account, ReadAsker::CheckNow).await);
    assert_eq!(fixture.legs.reads(), 1);
}

// A turn-end read asked while the turn still reads as live, as a provider's last usage comes
// before its run ends, is owed and runs once a turn closes, and only once. Killed by the owed read
// dropped (no read after the close) and by the owed mark kept (a second close reads again).
#[tokio::test]
async fn a_turn_end_read_asked_before_its_turn_closed_runs_once_the_turn_closes() {
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

    fixture.live_turns.is_live.store(true, Ordering::SeqCst);
    fixture
        .observer
        .shared
        .read_at_turn_end(account.account_id.clone())
        .await
        .expect("the turn-end read is owed");
    assert_eq!(fixture.legs.reads(), 0);

    fixture.live_turns.is_live.store(false, Ordering::SeqCst);
    fixture.observer.shared.read_owed_turn_end_reads().await;
    assert_eq!(fixture.legs.reads(), 1);

    fixture.observer.shared.read_owed_turn_end_reads().await;
    assert_eq!(fixture.legs.reads(), 1);
}

// A run that ends after a turn-end read found its turn live but before the read is marked owed
// still has that read asked: the run's end waits on the check's lock, so it finds the mark. Killed
// by the lock taken only for the mark, where the run's end finds nothing owed and the read is
// never asked, the run's end being given a tenth of a second to slip in between.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_ending_between_the_live_check_and_the_owed_mark_still_has_the_read_asked() {
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
    let shared = Arc::clone(&fixture.observer.shared);
    let live_turns = Arc::clone(&fixture.live_turns);
    let runtime = Handle::current();
    *lock(&fixture.live_turns.run_end_during_check) = Some(Box::new(move || {
        live_turns.is_live.store(false, Ordering::SeqCst);
        let (closed, closed_heard) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _runtime = runtime.enter();
            ProviderAccountObserver { shared }.turn_closed();
            let _unheard = closed.send(());
        });
        // Held off by the check's lock, the run's end cannot finish here.
        let _waited = closed_heard.recv_timeout(Duration::from_millis(100));
    }));
    fixture.live_turns.is_live.store(true, Ordering::SeqCst);

    fixture
        .observer
        .shared
        .read_at_turn_end(account.account_id.clone())
        .await
        .expect("the turn-end read is owed");

    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.legs.reads() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the run's end asks the owed read");
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
            Some(ProviderObservation::Figures(figures())),
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

// Each read with figures records its windows as the account's whole set and writes each identity
// column and the renewal time from what that read reported, an absent one keeping the stored
// value. Killed by the set not recorded or recorded as a push (the sink refuses a push), and by
// an absent member written as NULL over the one an earlier read reported.
#[tokio::test]
async fn a_read_s_figures_record_the_whole_set_and_each_reported_identity_column() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let refreshed_at =
        WireInstant::try_from("2026-10-29T18:00:00.000Z".to_owned()).expect("a wire instant");
    let first = ProviderAccountFigures {
        identity: ObservedAccountIdentity {
            email: Some(reported("the reported email")),
            org_id: Some(reported("org-1")),
            ..ObservedAccountIdentity::default()
        },
        refreshed_at: Some(refreshed_at.clone()),
        ..figures()
    };
    let second = ProviderAccountFigures {
        identity: ObservedAccountIdentity {
            plan: Some(reported("max")),
            org_id: Some(reported("org-2")),
            ..ObservedAccountIdentity::default()
        },
        ..figures()
    };
    let fixture = Fixture::open(
        &database,
        data_folder.path(),
        new_clock(),
        ScriptedLegs::answering([
            Some(ProviderObservation::Figures(first)),
            Some(ProviderObservation::Figures(second)),
        ]),
    )
    .await;
    let account = fixture.register().await;

    for _ in 0..2 {
        fixture.clock.advance(Duration::from_mins(6));
        read_reading(fixture.read(&account, ReadAsker::Cadence).await);
    }

    assert_eq!(
        fixture.usage.whole_sets(),
        [
            (account.account_id.clone(), figures().windows),
            (account.account_id.clone(), figures().windows),
        ]
    );
    let stored: [Option<String>; 5] = rusqlite::Connection::open(database.path())
        .expect("the database opens")
        .query_row(
            "SELECT observed_account_email, observed_account_plan, observed_account_org_id,
                    observed_account_org_name, last_refresh_observed_at
               FROM provider_accounts WHERE account_id = ?",
            [account.account_id.as_str()],
            |row| {
                Ok([
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ])
            },
        )
        .expect("the account's row reads");
    assert_eq!(
        stored,
        [
            Some("the reported email".to_owned()),
            Some("max".to_owned()),
            Some("org-2".to_owned()),
            None,
            Some(refreshed_at.as_str().to_owned()),
        ]
    );
}

// A read whose windows match the stored ones files no reading, yet the account's windows read as
// read at that read and go out as such: a window stored at 7:00 and read again unchanged at 7:30
// reads `7:30`. Killed by the read's time not written on the account's row, by the windows' read
// taking only their own stored time, and by the windows not published after the read.
#[tokio::test]
async fn a_read_matching_the_stored_windows_says_they_were_read_at_that_read() {
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
    let stored_at = super::ladder::wire_instant(fixture.clock.now());
    rusqlite::Connection::open(database.path())
        .expect("the database opens")
        .execute(
            "INSERT INTO provider_account_usage_windows
               (account_id, limit_id, window_mins, used_percent, observed_at,
                observed_credential_generation, source)
             VALUES (?1, 'session', 300, 40.0, ?2, 1, 'probe')",
            [account.account_id.as_str(), stored_at.as_str()],
        )
        .expect("the test stores the account's window");

    fixture.clock.advance(Duration::from_mins(30));
    let reading = read_reading(fixture.read(&account, ReadAsker::Cadence).await);

    let windows = read_usage_windows(&fixture.observer.shared.database_reads, None)
        .await
        .expect("the windows read");
    let [window] = windows.as_slice() else {
        panic!("one window is stored, not {windows:?}");
    };
    assert_ne!(stored_at, reading.read_at);
    assert_eq!(window.observed_at, reading.read_at);
    assert!(
        fixture.notifications.published().contains(
            &ProviderAccountNotification::UsageWindowUpdated {
                account_id: account.account_id.clone(),
                window: window.clone(),
            }
        ),
        "the window went out as read at the read"
    );
}

// A value the provider reported, as its identity member holds it.
fn reported<const MAX: usize>(text: &str) -> FreeFormText<MAX> {
    FreeFormText::new(text.to_owned()).expect("a reported value")
}
