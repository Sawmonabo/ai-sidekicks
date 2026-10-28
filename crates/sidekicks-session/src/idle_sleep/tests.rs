use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::command::AgentCommandEndedPayload;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::WallClockTimer;
use sidekicks_provider::command::running_set::{CommandEndingAppender, RunningCommandSets};
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::idle_sleep::{IdleSleepHolds, KeptSchedule, SessionSleepState};
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::port::session_wake::SessionWaker as _;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, test_run_id, test_session_id,
};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::sync::{oneshot, watch};

use super::kept_schedules::next_wake_at;
use super::{SessionIdleSleep, SessionIdleSleepDeps};
use crate::run::engine::test_fixture::insert_running_run;

const READ_STATEMENT_CAPACITY: usize = 16;

/// Past the idle limit, from the check that starts the idle clock.
const PAST_IDLE_LIMIT: Duration = Duration::from_secs(31 * 60);

struct DroppedEndings;

impl CommandEndingAppender for DroppedEndings {
    fn append(
        &self,
        _binding_id: RuntimeBindingId,
        _ending: AgentCommandEndedPayload,
        _summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

/// How many times the stand-in driver was asked to stop and to wake a session.
#[derive(Default)]
struct DriverCalls {
    sleeps: AtomicUsize,
    wakes: AtomicUsize,
}

struct Fixture {
    database: TestDatabase,
    idle_sleep: Arc<SessionIdleSleep>,
    running_commands: Arc<RunningCommandSets>,
    transition_lock: Arc<KeyedLock<SessionId>>,
}

/// An idle sleep over a test database whose sessions run on the table's first provider, answered
/// by `driver`.
async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new(crate::run::schema::schema_parts());
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let running_commands = Arc::new(RunningCommandSets::new(
        Arc::new(|_session: &SessionId| None),
        Arc::new(DroppedEndings),
    ));
    let transition_lock = Arc::new(KeyedLock::new());
    let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
        Arc::new(|_: &SessionId| None::<i64>);
    let idle_sleep = SessionIdleSleep::new(SessionIdleSleepDeps {
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        )),
        writer,
        providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
        read_damaged_from_sequence,
        transition_lock: Arc::clone(&transition_lock),
        running_commands: Arc::clone(&running_commands),
        scheduler: Arc::new(Scheduler::start(
            Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
            None,
            watch::channel(0).1,
        )),
    });
    Fixture {
        database,
        idle_sleep,
        running_commands,
        transition_lock,
    }
}

impl Fixture {
    /// A new active session whose lead runs on the table's first provider.
    fn add_session(&self) -> SessionId {
        let session_id = test_session_id();
        insert_session_row(
            &self.database.reader(),
            session_id.text().as_str(),
            None,
            None,
        );
        insert_lead(&self.database, session_id, PROVIDERS[0].id);
        session_id
    }

    /// Queues a message on `session_id`'s lead queue, as a send does.
    fn queue_message(&self, session_id: SessionId) {
        let now = WireInstant::now();
        self.database
            .reader()
            .execute(
                "INSERT INTO queue_items (id, session_id, payload, position, created_at, updated_at)
                 VALUES (?1, ?2, '{\"content\":\"Look again\"}', 0, ?3, ?3)",
                params![
                    mint_uuid_v7().to_string(),
                    session_id.text().as_str(),
                    now.as_str()
                ],
            )
            .expect("the test queues a message");
    }

    /// Wakes `session_id` once, so the idle sleep follows it awake, then runs a check that starts
    /// its idle clock, lets the limit pass and runs the check that stops it, waiting for the stop.
    async fn idle_past_the_limit(&self, session_id: SessionId) {
        self.idle_sleep
            .wake_for_message(session_id)
            .await
            .expect("the session is awake");
        self.idle_sleep.check().await;
        tokio::time::advance(PAST_IDLE_LIMIT).await;
        self.idle_sleep.check().await;
        self.idle_sleep.settle_transitions().await;
    }
}

/// A driver that answers `holds`, counts each stop and wake in `calls`, sleeps a session at once
/// and wakes it at once.
fn counting_driver(holds: IdleSleepHolds, calls: &Arc<DriverCalls>) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver.expect_idle_sleep_holds().returning(move |_| {
        let holds = holds.clone();
        async move { Ok(holds) }.boxed()
    });
    let sleeps = Arc::clone(calls);
    driver.expect_sleep_session().returning(move |_| {
        sleeps.sleeps.fetch_add(1, Ordering::SeqCst);
        async { Ok(SessionSleepState::Asleep) }.boxed()
    });
    let wakes = Arc::clone(calls);
    driver.expect_wake_session().returning(move |_| {
        wakes.wakes.fetch_add(1, Ordering::SeqCst);
        async { Ok(SessionSleepState::Awake) }.boxed()
    });
    driver
}

/// One thing that holds a session awake, or none.
#[derive(Clone, Copy, Debug)]
enum Hold {
    None,
    Turn,
    QueuedMessage,
    RunningCommand,
    OpenQuestion,
    SideQuestion,
    // A pending wake-up and a one-shot job alike: a fire the provider loses at a stop.
    OneShotFire,
    VoiceCall,
}

impl Hold {
    fn provider_holds(self) -> IdleSleepHolds {
        match self {
            Self::OpenQuestion => IdleSleepHolds {
                open_requests: 1,
                ..IdleSleepHolds::default()
            },
            Self::SideQuestion => IdleSleepHolds {
                is_side_question_running: true,
                ..IdleSleepHolds::default()
            },
            Self::OneShotFire => IdleSleepHolds {
                schedules: vec![KeptSchedule::Once {
                    fires_at: Timestamp::now() + SignedDuration::from_hours(1),
                }],
                ..IdleSleepHolds::default()
            },
            Self::None
            | Self::Turn
            | Self::QueuedMessage
            | Self::RunningCommand
            | Self::VoiceCall => IdleSleepHolds::default(),
        }
    }
}

// Each hold, read where its owner keeps it, keeps an idle session awake past the limit, and with
// none the session sleeps. Killed by dropping any one hold from the read or the registered count.
#[rstest]
#[case::nothing(Hold::None, 1)]
#[case::turn(Hold::Turn, 0)]
#[case::queued_message(Hold::QueuedMessage, 0)]
#[case::running_command(Hold::RunningCommand, 0)]
#[case::open_question(Hold::OpenQuestion, 0)]
#[case::side_question(Hold::SideQuestion, 0)]
#[case::one_shot_fire(Hold::OneShotFire, 0)]
#[case::voice_call(Hold::VoiceCall, 0)]
#[tokio::test(start_paused = true)]
async fn each_hold_keeps_an_idle_session_awake(#[case] hold: Hold, #[case] sleeps: usize) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(counting_driver(hold.provider_holds(), &calls)).await;
    let session_id = fixture.add_session();
    let _voice_call = match hold {
        Hold::Turn => {
            insert_running_run(&fixture.database, session_id, test_run_id());
            None
        }
        Hold::QueuedMessage => {
            fixture.queue_message(session_id);
            None
        }
        Hold::RunningCommand => {
            fixture
                .running_commands
                .start_test_command(session_id, test_run_id());
            None
        }
        Hold::VoiceCall => Some(
            fixture
                .idle_sleep
                .hold(session_id)
                .await
                .expect("the voice call holds the session"),
        ),
        Hold::None | Hold::OpenQuestion | Hold::SideQuestion | Hold::OneShotFire => None,
    };

    fixture.idle_past_the_limit(session_id).await;

    assert_eq!(calls.sleeps.load(Ordering::SeqCst), sleeps);
}

// A message queued while the stop waits for the session's lock, after the check found it idle,
// keeps it awake, because the stop reads every hold again under the lock. Killed by a stop that
// trusts the check's read.
#[tokio::test(start_paused = true)]
async fn a_message_sent_at_the_stop_keeps_the_session_awake() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(counting_driver(IdleSleepHolds::default(), &calls)).await;
    let session_id = fixture.add_session();
    fixture
        .idle_sleep
        .wake_for_message(session_id)
        .await
        .expect("the session is awake");
    fixture.idle_sleep.check().await;
    tokio::time::advance(PAST_IDLE_LIMIT).await;
    let held = fixture.transition_lock.acquire(session_id).await;

    fixture.idle_sleep.check().await;
    fixture.queue_message(session_id);
    drop(held);
    fixture.idle_sleep.settle_transitions().await;

    assert_eq!(calls.sleeps.load(Ordering::SeqCst), 0);
}

// A message and a voice call's hold that reach a session while its process stops are kept, and
// one resume wakes the session once the process exited, answering both. Killed by a trigger or a
// hold dropped in the stopping state, and by a resume per trigger.
#[tokio::test(start_paused = true)]
async fn a_message_during_the_stop_wakes_the_session_after_the_exit() {
    let calls = Arc::new(DriverCalls::default());
    let (stopping, stop_reached) = oneshot::channel::<()>();
    let (exit, exited) = oneshot::channel::<()>();
    let stopping = std::sync::Mutex::new(Some(stopping));
    let exited = futures::FutureExt::shared(exited);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_idle_sleep_holds()
        .returning(|_| async { Ok(IdleSleepHolds::default()) }.boxed());
    driver.expect_sleep_session().returning(move |_| {
        if let Some(stopping) = stopping.lock().expect("never poisoned").take() {
            stopping.send(()).expect("the test waits for the stop");
        }
        let exited = exited.clone();
        async move {
            exited.await.expect("the test lets the process exit");
            Ok(SessionSleepState::Asleep)
        }
        .boxed()
    });
    let wakes = Arc::clone(&calls);
    driver.expect_wake_session().returning(move |_| {
        wakes.wakes.fetch_add(1, Ordering::SeqCst);
        async { Ok(SessionSleepState::Awake) }.boxed()
    });
    let fixture = fixture(driver).await;
    let session_id = fixture.add_session();
    fixture
        .idle_sleep
        .wake_for_message(session_id)
        .await
        .expect("the session is awake");
    fixture.idle_sleep.check().await;
    tokio::time::advance(PAST_IDLE_LIMIT).await;
    fixture.idle_sleep.check().await;
    stop_reached.await.expect("the stop reaches the driver");

    let mut message = fixture.idle_sleep.wake_for_message(session_id);
    assert!(futures::poll!(&mut message).is_pending());
    let mut voice_call = fixture.idle_sleep.hold(session_id).boxed();
    assert!(futures::poll!(&mut voice_call).is_pending());
    exit.send(()).expect("the stop waits for the exit");
    fixture.idle_sleep.settle_transitions().await;

    message.await.expect("the session woke for the message");
    let _voice_call = voice_call.await.expect("the voice call holds the session");
    assert_eq!(calls.wakes.load(Ordering::SeqCst), 2);
}

// A recurring job lets the session sleep and arms its wake two minutes before the job's next run,
// and that wake resumes the session. Killed by a recurring job held as a hold, and by a wake
// armed at the run itself.
#[tokio::test(start_paused = true)]
async fn a_recurring_job_sleeps_and_wakes_the_session_before_its_run() {
    let calls = Arc::new(DriverCalls::default());
    let next_run = Timestamp::now() + SignedDuration::from_hours(3);
    let holds = IdleSleepHolds {
        schedules: vec![KeptSchedule::Recurring {
            cron: "0 * * * *".to_owned(),
            next_fire_at: Some(next_run),
        }],
        ..IdleSleepHolds::default()
    };
    let fixture = fixture(counting_driver(holds, &calls)).await;
    let session_id = fixture.add_session();

    fixture.idle_past_the_limit(session_id).await;

    assert_eq!(calls.sleeps.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.idle_sleep.armed_wake_at(session_id),
        Some(next_run - SignedDuration::from_mins(2))
    );
    fixture.idle_sleep.fire_scheduled_wake(session_id);
    fixture.idle_sleep.settle_transitions().await;
    assert_eq!(calls.wakes.load(Ordering::SeqCst), 2);
}

// At the daemon's start a session found asleep stays asleep, one whose kept fire already passed
// among them, and one with a job ahead is woken on its schedule only. Killed by waking every
// stored session at the start.
#[tokio::test(start_paused = true)]
async fn the_start_wakes_only_a_session_with_a_job_ahead_on_its_schedule() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(counting_driver(IdleSleepHolds::default(), &calls)).await;
    let past_fire = fixture.add_session();
    let with_job = fixture.add_session();
    let next_run = Timestamp::now() + SignedDuration::from_hours(3);
    let stored = |session_id: SessionId, fires_at: Option<Timestamp>, next: Option<Timestamp>| {
        let instant = |at: Timestamp| {
            WireInstant::from_timestamp(at)
                .expect("a test instant is after the year 0000")
                .as_str()
                .to_owned()
        };
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO session_kept_schedules
                   (session_id, position, fires_at, cron, next_fire_at)
                 VALUES (?1, 0, ?2, ?3, ?4)",
                params![
                    session_id.text().as_str(),
                    fires_at.map(instant),
                    fires_at.is_none().then_some("0 * * * *"),
                    next.map(instant),
                ],
            )
            .expect("the test stores a kept schedule");
    };
    stored(
        past_fire,
        Some(Timestamp::now() - SignedDuration::from_hours(1)),
        None,
    );
    stored(with_job, None, Some(next_run));

    fixture
        .idle_sleep
        .start()
        .await
        .expect("the idle sleep starts");
    fixture.idle_sleep.settle_transitions().await;

    assert_eq!(calls.wakes.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.idle_sleep.armed_wake_at(past_fire), None);
    assert_eq!(
        fixture.idle_sleep.armed_wake_at(with_job),
        Some(next_run - SignedDuration::from_mins(2))
    );
    fixture.idle_sleep.fire_scheduled_wake(with_job);
    fixture.idle_sleep.settle_transitions().await;
    assert_eq!(calls.wakes.load(Ordering::SeqCst), 1);
    fixture.idle_sleep.stop().await;
}

// A recurring job's wake comes two minutes before its schedule's next match in the computer's
// zone, the provider's own next run used while it is still ahead. Killed by a wake at the match,
// by the provider's figure read past its time, and by a match read in another zone.
#[test]
fn a_recurring_wake_comes_two_minutes_before_the_next_match() {
    let zone = TimeZone::get("America/New_York").expect("the zone database knows New York");
    let now: Timestamp = "2026-10-28T12:00:00Z".parse().expect("a test instant");
    let job = |next_fire_at: Option<Timestamp>| KeptSchedule::Recurring {
        cron: "0 9 * * *".to_owned(),
        next_fire_at,
    };
    let past: Timestamp = "2026-10-28T11:00:00Z".parse().expect("a test instant");
    let ahead: Timestamp = "2026-10-28T15:00:00Z".parse().expect("a test instant");

    // Noon UTC is 08:00 in New York, whose next 09:00 is 13:00 UTC.
    assert_eq!(
        next_wake_at(&[job(Some(past))], now, &zone),
        Some("2026-10-28T12:58:00Z".parse().expect("a test instant"))
    );
    assert_eq!(
        next_wake_at(&[job(Some(ahead))], now, &zone),
        Some("2026-10-28T14:58:00Z".parse().expect("a test instant"))
    );
}
