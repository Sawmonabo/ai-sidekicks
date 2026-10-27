//! Pause and resume over a test database holding one run bound to the table's first provider,
//! whose driver is a stand-in: the order a call is refused in, a resume whose answer never came,
//! a run ended under the driver call, and the provider's reports held while a resume runs.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::control::{AgentRunPauseRequest, AgentRunResumeRequest};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::{TakenMessages, WaitingMessage};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::port::run_pause::{ContinuedMessages, ContinuedMessagesError};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{RUN_PAUSE_STATEMENT_CAPACITY, RunPauseControl, RunPauseError};
use crate::driver_resolution::LiveRunDriverError;
use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{insert_running_run, test_engine};
use crate::run::engine::tests::SETTLE_WAIT;
use crate::run::engine::{InterruptRoute, RunEngine};
use crate::run::refusals::RunRefusal;
use crate::run::state_change::RunStateChange;

/// How long a call held behind a resume is watched to show it waits.
const HELD_WATCH: Duration = Duration::from_millis(200);

/// A run bound to the table's first provider, the engine that moves it and the control under test.
struct Fixture {
    database: TestDatabase,
    engine: Arc<RunEngine>,
    control: RunPauseControl,
    session_id: SessionId,
    run_id: RunId,
    _log: TestLog,
    _home: TempDir,
}

impl Fixture {
    /// Sets the run's state and version as a writer outside the engine would.
    fn set_run(&self, state: &str, version: i64) {
        set_run(&self.database, self.run_id, state, version);
    }

    /// The run's state and version as stored.
    fn run(&self) -> (String, i64) {
        stored_run(&self.database, self.run_id)
    }

    /// Asks the control to resume the run, which the caller read at `version`.
    async fn resume(
        &self,
        version: u64,
        continued: &dyn ContinuedMessages,
    ) -> Result<(), RunPauseError> {
        self.control
            .resume(
                &AgentRunResumeRequest {
                    target_run_id: self.run_id,
                    expected_run_version: safe(version),
                },
                continued,
            )
            .await
            .map(drop)
    }

    /// Reports the provider moved the run to `entry`, as its event delivery does.
    fn report(&self, entry: RunStateEntry) -> tokio::task::JoinHandle<bool> {
        let engine = Arc::clone(&self.engine);
        let change = RunStateChange::new(self.run_id, entry);
        tokio::spawn(async move {
            engine
                .apply_provider_state_change(change, None)
                .await
                .is_ok()
        })
    }
}

async fn fixture(mut driver: MockProviderDriver, state: &str) -> Fixture {
    driver
        .expect_message_handing()
        .return_const(MessageHanding {
            hands_at: HandMoment::AtOnce,
            can_withdraw: true,
            kept_by_process: false,
            reads_priority_message: false,
        });
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id: SessionId = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    bind_run_to_first_provider(&database, run_id);
    set_run(&database, run_id, state, 1);
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let control = RunPauseControl::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_PAUSE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&engine),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
    );
    Fixture {
        database,
        engine,
        control,
        session_id,
        run_id,
        _log: log,
        _home: home,
    }
}

fn set_run(database: &TestDatabase, run_id: RunId, state: &str, version: i64) {
    database
        .reader()
        .execute(
            "UPDATE runs SET state = ?2, run_version = ?3 WHERE run_id = ?1",
            params![run_id.text().as_str(), state, version],
        )
        .expect("the test moves the run");
}

fn stored_run(database: &TestDatabase, run_id: RunId) -> (String, i64) {
    database
        .reader()
        .query_row(
            "SELECT state, run_version FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the run")
}

fn safe(version: u64) -> SafeInt<0> {
    SafeInt::new(version).expect("the test's version is a safe integer")
}

/// A message waiting for the run.
fn waiting_message() -> WaitingMessage {
    WaitingMessage {
        id: QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an item id"),
        content: MessageContent::new("carry on".to_owned()).expect("the words are a message"),
        attachments: Vec::new(),
        skills: Vec::new(),
    }
}

/// The waiting messages as the queue keeps them: read until taken, given back or kept, and a
/// kept one read by no later resume.
struct WaitingMessages {
    waiting: Mutex<Vec<WaitingMessage>>,
    kept: Mutex<Vec<WaitingMessage>>,
    releases: AtomicUsize,
    admissions: AtomicUsize,
    // The kept messages a settle delivered with the run, those it gave back, and those it ended
    // not delivered.
    settled_taken: Mutex<Vec<QueueItemId>>,
    settled_given_back: Mutex<Vec<QueueItemId>>,
    failed: Mutex<Vec<QueueItemId>>,
    session_lock: KeyedLock<SessionId>,
}

impl Default for WaitingMessages {
    fn default() -> Self {
        Self {
            waiting: Mutex::default(),
            kept: Mutex::default(),
            releases: AtomicUsize::default(),
            admissions: AtomicUsize::default(),
            settled_taken: Mutex::default(),
            settled_given_back: Mutex::default(),
            failed: Mutex::default(),
            session_lock: KeyedLock::new(),
        }
    }
}

impl WaitingMessages {
    fn holding(message: WaitingMessage) -> Self {
        Self {
            waiting: Mutex::new(vec![message]),
            ..Self::default()
        }
    }

    fn kept_messages(&self) -> Vec<WaitingMessage> {
        self.kept.lock().expect("the kept messages read").clone()
    }
}

impl ContinuedMessages for WaitingMessages {
    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        self.session_lock.acquire(session_id).boxed()
    }

    fn read(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _handing: MessageHanding,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>> {
        let waiting = self.waiting.lock().expect("the messages read").clone();
        async move { Ok(waiting) }.boxed()
    }

    fn admit(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.waiting.lock().expect("the messages read").clear();
        self.admissions.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn release(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn keep(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) {
        let mut waiting = self.waiting.lock().expect("the messages read");
        self.kept
            .lock()
            .expect("the kept messages read")
            .append(&mut waiting);
    }

    fn kept(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) -> Vec<QueueItemId> {
        self.kept_messages()
            .iter()
            .map(|message| message.id)
            .collect()
    }

    // The test's provider process keeps nothing past a run's end.
    fn kept_unheld(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId> {
        self.kept(hold, run_id)
    }

    fn settle_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        settled: &[QueueItemId],
        taken: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        let mut kept = self.kept.lock().expect("the kept messages read");
        let (settling, left): (Vec<_>, Vec<_>) = kept
            .drain(..)
            .partition(|message| settled.contains(&message.id));
        *kept = left;
        drop(kept);
        for message in settling {
            if taken.contains(&message.id) {
                self.settled_taken
                    .lock()
                    .expect("the settled messages read")
                    .push(message.id);
            } else {
                self.settled_given_back
                    .lock()
                    .expect("the settled messages read")
                    .push(message.id);
                self.waiting
                    .lock()
                    .expect("the messages read")
                    .push(message);
            }
        }
        async { Ok(()) }.boxed()
    }

    fn fail_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        message_ids: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.kept
            .lock()
            .expect("the kept messages read")
            .retain(|message| !message_ids.contains(&message.id));
        self.failed
            .lock()
            .expect("the failed messages read")
            .extend_from_slice(message_ids);
        async { Ok(()) }.boxed()
    }
}

/// A driver call the test holds: it signals when it starts, then waits for the test's answer.
struct HeldCall {
    started: oneshot::Receiver<()>,
    answer: oneshot::Sender<Result<(), DriverError>>,
}

/// Has `driver`'s one resume wait for the test's answer.
fn hold_resume(driver: &mut MockProviderDriver) -> HeldCall {
    let (started_sender, started) = oneshot::channel();
    let (answer, answered) = oneshot::channel();
    let held = Mutex::new(Some((started_sender, answered)));
    driver.expect_resume_run().times(1).returning(move |_| {
        let (started, answered) = held
            .lock()
            .expect("the held call reads")
            .take()
            .expect("the driver is resumed once");
        started.send(()).expect("the test waits for the call");
        async move { answered.await.expect("the test answers the call") }.boxed()
    });
    HeldCall { started, answer }
}

/// How a refused resume answers.
#[derive(Clone, Copy, Debug)]
enum Refusal {
    NotFound,
    InvalidTransition,
    VersionStale,
    ProviderNotFound,
    Unbound,
}

/// What the test does to the run before the resume.
#[derive(Clone, Copy, Debug)]
enum Setup {
    Unknown,
    Ended,
    StaleOnUnregisteredProvider,
    UnregisteredProvider,
    Unbound,
}

// A resume is refused in order, run, version, state, then driver, with the driver never asked and
// no message read: an unknown run is not found, an ended run cannot move, a stale version is
// refused before a provider no driver answers, and a live run with no binding is a fault, never a
// refusal. Killed by finding the driver before the checks or answering a run with no binding as
// not found.
#[rstest]
#[case::unknown_run(Setup::Unknown, Refusal::NotFound)]
#[case::ended_run(Setup::Ended, Refusal::InvalidTransition)]
#[case::stale_version(Setup::StaleOnUnregisteredProvider, Refusal::VersionStale)]
#[case::unregistered_provider(Setup::UnregisteredProvider, Refusal::ProviderNotFound)]
#[case::no_binding(Setup::Unbound, Refusal::Unbound)]
#[tokio::test]
async fn a_resume_is_refused_by_the_run_then_the_version_then_the_state_then_the_driver(
    #[case] setup: Setup,
    #[case] expected: Refusal,
) {
    let fixture = fixture(MockProviderDriver::new(), "paused").await;
    let mut version = 1;
    let rebind = |provider: &str| {
        fixture
            .database
            .reader()
            .execute(
                "UPDATE runtime_bindings SET provider_name = ?2 WHERE run_id = ?1",
                params![fixture.run_id.text().as_str(), provider],
            )
            .expect("the test rebinds the run");
    };
    match setup {
        Setup::Unknown => {
            fixture
                .database
                .reader()
                .execute_batch("DELETE FROM runtime_bindings; DELETE FROM runs;")
                .expect("the test forgets the run");
        }
        Setup::Ended => fixture.set_run("completed", 1),
        Setup::StaleOnUnregisteredProvider => {
            rebind(PROVIDERS[1].id);
            version = 0;
        }
        Setup::UnregisteredProvider => rebind(PROVIDERS[1].id),
        Setup::Unbound => {
            fixture
                .database
                .reader()
                .execute("DELETE FROM runtime_bindings", [])
                .expect("the test unbinds the run");
        }
    }
    let messages = WaitingMessages::holding(waiting_message());

    let resumed = fixture.resume(version, &messages).await;

    match (expected, &resumed) {
        (Refusal::NotFound, Err(RunPauseError::Refused(RunRefusal::NotFound { .. })))
        | (
            Refusal::InvalidTransition,
            Err(RunPauseError::Refused(RunRefusal::InvalidTransition { .. })),
        )
        | (Refusal::VersionStale, Err(RunPauseError::Refused(RunRefusal::VersionStale { .. })))
        | (Refusal::Unbound, Err(RunPauseError::NoDriver(LiveRunDriverError::Unbound { .. }))) => {}
        (
            Refusal::ProviderNotFound,
            Err(RunPauseError::NoDriver(LiveRunDriverError::ProviderNotFound(refusal))),
        ) => assert_eq!(refusal.code, RefusalCode::ProviderNotFound),
        _ => panic!("expected {expected:?}, got {resumed:?}"),
    }
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
    assert_eq!(messages.kept_messages(), []);
}

/// How the driver fails a resume.
#[derive(Clone, Copy, Debug)]
enum ResumeFailure {
    /// It refused it: nothing reached the provider.
    Refused,
    /// The request went out and no answer came.
    Unanswered,
}

// A resume the driver fails moves nothing and leaves the run paused: one it refused gives its
// messages back, so the next resume sends them, and one whose answer never came keeps them, so the
// next resume sends none of them again. Killed by moving the run before the driver, by giving the
// messages back on an unknown outcome, or by keeping them on a refusal.
#[rstest]
#[case::refused(ResumeFailure::Refused)]
#[case::unanswered(ResumeFailure::Unanswered)]
#[tokio::test]
async fn a_failed_resume_moves_nothing_and_sends_each_message_once(#[case] failure: ResumeFailure) {
    let message = waiting_message();
    let sent: Arc<Mutex<Vec<Vec<WaitingMessage>>>> = Arc::default();
    let mut driver = MockProviderDriver::new();
    let calls = AtomicUsize::new(0);
    let recorded = Arc::clone(&sent);
    driver
        .expect_resume_run()
        .times(2)
        .returning(move |params| {
            recorded
                .lock()
                .expect("the sent messages read")
                .push(params.messages);
            let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            async move {
                match (is_first, failure) {
                    (true, ResumeFailure::Refused) => Err(DriverError::Internal(
                        "the provider would not resume".into(),
                    )),
                    (true, ResumeFailure::Unanswered) => Err(unanswered()),
                    (false, _) => Ok(()),
                }
            }
            .boxed()
        });
    let fixture = fixture(driver, "paused").await;
    let messages = WaitingMessages::holding(message.clone());

    let first = fixture.resume(1, &messages).await;
    let after_first = fixture.run();
    let second = fixture.resume(1, &messages).await;

    match (failure, &first) {
        (ResumeFailure::Refused, Err(RunPauseError::Driver(DriverError::Internal(_))))
        | (ResumeFailure::Unanswered, Err(RunPauseError::Driver(DriverError::Unanswered(_)))) => {}
        _ => panic!("expected {failure:?}, got {first:?}"),
    }
    assert_eq!(after_first, ("paused".to_owned(), 1));
    assert!(second.is_ok(), "{second:?}");
    assert_eq!(fixture.run(), ("running".to_owned(), 2));
    let (second_sent, kept, releases) = match failure {
        ResumeFailure::Refused => (vec![message.clone()], Vec::new(), 1),
        ResumeFailure::Unanswered => (Vec::new(), vec![message.clone()], 0),
    };
    assert_eq!(
        *sent.lock().expect("the sent messages read"),
        vec![vec![message], second_sent]
    );
    assert_eq!(messages.kept_messages(), kept);
    assert_eq!(messages.releases.load(Ordering::SeqCst), releases);
}

// A run a provider process's exit ended while its driver took the resume is not moved, and the
// messages the provider took are never given back: one the exit left interrupted, a person's
// interrupt pending, answers that the version the caller read is stale and delivers them with the
// run; one it left stopped answers that it cannot move, and the provider's own record, holding
// them, settles them delivered. Killed by moving the run before the driver, or by giving the
// messages back.
#[rstest]
#[case::interrupt_pending("interrupted", Refusal::VersionStale)]
#[case::no_interrupt_pending("stopped", Refusal::InvalidTransition)]
#[tokio::test]
async fn a_run_ended_under_the_resume_is_not_moved(
    #[case] ended_as: &'static str,
    #[case] expected: Refusal,
) {
    let mut driver = MockProviderDriver::new();
    let database = Arc::new(Mutex::new(None::<(std::path::PathBuf, RunId)>));
    let exit = Arc::clone(&database);
    driver.expect_resume_run().times(1).returning(move |_| {
        let (path, run_id) = exit
            .lock()
            .expect("the run reads")
            .clone()
            .expect("the test names its run");
        rusqlite::Connection::open(path)
            .and_then(|connection| {
                connection.execute(
                    "UPDATE runs SET state = ?2, run_version = 2 WHERE run_id = ?1",
                    params![run_id.text().as_str(), ended_as],
                )
            })
            .expect("the process exit ends the run");
        async { Ok(()) }.boxed()
    });
    driver.expect_find_taken_messages().returning(|params| {
        let taken = params.message_ids;
        async move { Ok(TakenMessages { taken }) }.boxed()
    });
    let fixture = fixture(driver, "paused").await;
    *database.lock().expect("the run reads") = Some((fixture.database.path(), fixture.run_id));
    let messages = WaitingMessages::holding(waiting_message());

    let resumed = fixture.resume(1, &messages).await;

    match (expected, &resumed) {
        (Refusal::VersionStale, Err(RunPauseError::Refused(RunRefusal::VersionStale { .. })))
        | (
            Refusal::InvalidTransition,
            Err(RunPauseError::Refused(RunRefusal::InvalidTransition { .. })),
        ) => {}
        _ => panic!("expected {expected:?}, got {resumed:?}"),
    }
    assert_eq!(fixture.run(), (ended_as.to_owned(), 2));
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
    let delivered = match expected {
        Refusal::VersionStale => messages.admissions.load(Ordering::SeqCst),
        Refusal::NotFound
        | Refusal::InvalidTransition
        | Refusal::ProviderNotFound
        | Refusal::Unbound => messages
            .settled_taken
            .lock()
            .expect("the settled messages read")
            .len(),
    };
    assert_eq!(delivered, 1);
    assert_eq!(messages.kept_messages(), []);
}

// While the driver takes a resume, the provider's `paused` report on the pausing run and a
// person's interrupt both wait; once it took it, the run is running, the held report is refused
// from there and the interrupt reaches the driver. Killed by resuming without holding the run.
#[tokio::test]
async fn reports_and_interrupts_wait_for_a_resume_and_the_run_stays_running() {
    let mut driver = MockProviderDriver::new();
    let held = hold_resume(&mut driver);
    let fixture = Arc::new(fixture(driver, "pausing").await);
    let messages = Arc::new(WaitingMessages::default());

    let resuming = {
        let fixture = Arc::clone(&fixture);
        let messages = Arc::clone(&messages);
        tokio::spawn(async move { fixture.resume(1, messages.as_ref()).await })
    };
    tokio::time::timeout(SETTLE_WAIT, held.started)
        .await
        .expect("the driver is asked to resume")
        .expect("the driver signals its call");
    let mut report = fixture.report(RunStateEntry::Paused);
    let mut interrupt = {
        let engine = Arc::clone(&fixture.engine);
        let run_id = fixture.run_id;
        tokio::spawn(async move { engine.route_interrupt(run_id).await.ok() })
    };
    let is_report_held = tokio::time::timeout(HELD_WATCH, &mut report).await.is_err();
    let is_interrupt_held = tokio::time::timeout(HELD_WATCH, &mut interrupt)
        .await
        .is_err();
    let state_while_held = fixture.run();
    held.answer
        .send(Ok(()))
        .expect("the resume waits for its answer");

    let resumed = resuming.await.expect("the resume ends");
    let is_report_applied = report.await.expect("the report ends");
    let routed = interrupt.await.expect("the interrupt ends");

    assert!(is_report_held && is_interrupt_held);
    assert_eq!(state_while_held, ("pausing".to_owned(), 1));
    assert!(resumed.is_ok(), "{resumed:?}");
    assert!(!is_report_applied);
    assert!(matches!(routed, Some(InterruptRoute::Driver)), "{routed:?}");
    assert_eq!(fixture.run(), ("running".to_owned(), 2));
}

// A pause whose answer never came leaves the run pausing, where the provider's own `paused`
// report applies; only a clear refusal returns it to running. Killed by returning the run to
// running on an unknown outcome.
#[tokio::test]
async fn a_pause_whose_answer_never_came_stays_pausing_for_the_providers_report() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_pause_run()
        .times(1)
        .returning(|_| async { Err(unanswered()) }.boxed());
    let fixture = fixture(driver, "running").await;

    let paused = fixture
        .control
        .pause(&AgentRunPauseRequest {
            target_run_id: fixture.run_id,
            expected_run_version: safe(1),
        })
        .await;
    let after_pause = fixture.run();
    let is_report_applied = fixture
        .report(RunStateEntry::Paused)
        .await
        .expect("the report ends");

    assert!(
        matches!(
            paused,
            Err(RunPauseError::Driver(DriverError::Unanswered(_)))
        ),
        "{paused:?}"
    );
    assert_eq!(after_pause, ("pausing".to_owned(), 2));
    assert!(is_report_applied);
    assert_eq!(fixture.run().0, "paused");
}

// A provider's report that lands while a resume reads its run waits for the resume, which sends
// the messages once and moves the run to running; the driver is never asked and then overruled.
// Killed by reading the run before holding it as being resumed: the report then moves the run
// under the resume's read, and the resume's guarded move refuses.
#[tokio::test]
async fn a_report_during_the_resumes_run_read_waits_and_the_resume_takes_the_run() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_run()
        .times(1)
        .returning(|_| async { Ok(()) }.boxed());
    let fixture = Arc::new(fixture(driver, "pausing").await);
    let held_read = fixture.engine.resume_read_pause().arm();
    let messages = Arc::new(WaitingMessages::holding(waiting_message()));

    let resuming = {
        let fixture = Arc::clone(&fixture);
        let messages = Arc::clone(&messages);
        tokio::spawn(async move { fixture.resume(1, messages.as_ref()).await })
    };
    tokio::time::timeout(SETTLE_WAIT, held_read.reached)
        .await
        .expect("the resume reads its run")
        .expect("the read signals its start");
    let mut report = fixture.report(RunStateEntry::Paused);
    let is_report_held = tokio::time::timeout(HELD_WATCH, &mut report).await.is_err();
    held_read
        .release
        .send(())
        .expect("the read waits to be let go");
    let resumed = resuming.await.expect("the resume ends");
    let is_report_applied = report.await.expect("the report ends");

    assert!(is_report_held);
    assert!(resumed.is_ok(), "{resumed:?}");
    assert!(!is_report_applied);
    assert_eq!(fixture.run(), ("running".to_owned(), 2));
    assert_eq!(messages.admissions.load(Ordering::SeqCst), 1);
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
}

/// What settles the messages a resume kept.
#[derive(Clone, Copy, Debug)]
enum KeptSettle {
    /// The provider reports the run running again.
    ProviderRuns,
    /// The run ends, and the provider's record does not hold them.
    RunEndsUnrecorded,
}

// A message a resume sent with no answer back stays kept until the provider shows what became of
// it: its report of the run running again delivers it with the run, and at the run's end the
// provider's own record, not holding it, gives it back to go once more under its own id. Killed by
// settling a kept message on anything but that proof, or by giving back one the provider took.
#[rstest]
#[case::provider_runs(KeptSettle::ProviderRuns)]
#[case::run_ends_unrecorded(KeptSettle::RunEndsUnrecorded)]
#[tokio::test]
async fn a_kept_message_settles_on_the_providers_own_word(#[case] settle: KeptSettle) {
    let message = waiting_message();
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_run()
        .times(1)
        .returning(|_| async { Err(unanswered()) }.boxed());
    let looked_up = Arc::new(Mutex::new(Vec::new()));
    let lookups = Arc::clone(&looked_up);
    driver
        .expect_find_taken_messages()
        .returning(move |params| {
            lookups
                .lock()
                .expect("the lookups read")
                .push(params.message_ids);
            async { Ok(TakenMessages { taken: Vec::new() }) }.boxed()
        });
    let fixture = fixture(driver, "paused").await;
    let messages = WaitingMessages::holding(message.clone());

    let resumed = fixture.resume(1, &messages).await;
    let kept_after_the_resume = messages.kept_messages();
    let settled = match settle {
        KeptSettle::ProviderRuns => {
            fixture
                .control
                .settle_kept_as_taken(fixture.session_id, fixture.run_id, &messages)
                .await
        }
        KeptSettle::RunEndsUnrecorded => {
            fixture.set_run("stopped", 2);
            fixture
                .control
                .settle_kept_by_record(fixture.session_id, fixture.run_id, &messages)
                .await
        }
    };

    assert!(
        matches!(
            resumed,
            Err(RunPauseError::Driver(DriverError::Unanswered(_)))
        ),
        "{resumed:?}"
    );
    assert_eq!(kept_after_the_resume, vec![message.clone()]);
    assert!(settled.is_ok(), "{settled:?}");
    assert_eq!(messages.kept_messages(), []);
    let taken = messages
        .settled_taken
        .lock()
        .expect("the settled messages read")
        .clone();
    let given_back = messages
        .settled_given_back
        .lock()
        .expect("the settled messages read")
        .clone();
    let lookups = looked_up.lock().expect("the lookups read").clone();
    match settle {
        KeptSettle::ProviderRuns => {
            assert_eq!((taken, given_back), (vec![message.id], Vec::new()));
            assert_eq!(lookups, Vec::<Vec<QueueItemId>>::new());
        }
        KeptSettle::RunEndsUnrecorded => {
            assert_eq!((taken, given_back), (Vec::new(), vec![message.id]));
            assert_eq!(lookups, vec![vec![message.id]]);
        }
    }
}

/// How the provider's record answers the read of a kept message.
#[derive(Clone, Copy, Debug)]
enum RecordRead {
    /// It cannot be read.
    Unreadable,
    /// The read went out and no answer came.
    Unanswered,
}

// At the run's end a provider's record that cannot be read ends a kept message not delivered,
// for the person to send again, and one whose read was never answered keeps it for the next
// settle to read again. Killed by keeping a message whose record cannot be read, or by ending one
// whose read went unanswered.
#[rstest]
#[case::unreadable(RecordRead::Unreadable)]
#[case::unanswered(RecordRead::Unanswered)]
#[tokio::test]
async fn a_kept_message_whose_record_fails_ends_not_delivered_or_waits_for_the_next_read(
    #[case] record: RecordRead,
) {
    let message = waiting_message();
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_run()
        .times(1)
        .returning(|_| async { Err(unanswered()) }.boxed());
    driver
        .expect_find_taken_messages()
        .times(1)
        .returning(move |_| {
            async move {
                Err(match record {
                    RecordRead::Unreadable => {
                        DriverError::Internal("the provider's record is gone".into())
                    }
                    RecordRead::Unanswered => unanswered(),
                })
            }
            .boxed()
        });
    let fixture = fixture(driver, "paused").await;
    let messages = WaitingMessages::holding(message.clone());
    let resumed = fixture.resume(1, &messages).await;
    fixture.set_run("stopped", 2);

    let settled = fixture
        .control
        .settle_kept_by_record(fixture.session_id, fixture.run_id, &messages)
        .await;

    assert!(resumed.is_err(), "{resumed:?}");
    let failed = messages
        .failed
        .lock()
        .expect("the failed messages read")
        .clone();
    match record {
        RecordRead::Unreadable => {
            assert!(
                matches!(
                    settled,
                    Err(RunPauseError::RecordUnreadable {
                        give_back: None,
                        ..
                    })
                ),
                "{settled:?}"
            );
            assert_eq!(failed, vec![message.id]);
            assert_eq!(messages.kept_messages(), []);
        }
        RecordRead::Unanswered => {
            assert!(
                matches!(settled, Err(RunPauseError::RecordUnanswered(_))),
                "{settled:?}"
            );
            assert_eq!(failed, Vec::<QueueItemId>::new());
            assert_eq!(messages.kept_messages(), vec![message]);
        }
    }
}
