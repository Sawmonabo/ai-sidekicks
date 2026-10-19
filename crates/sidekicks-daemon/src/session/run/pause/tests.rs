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
use sidekicks_contracts::wire::integer::SafeInt;
use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{ContinuedMessages, ContinuedMessagesError, RunPauseControl, RunPauseError};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::LiveRunDriverError;
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::error_causes::RequestUnanswered;
use crate::provider::driver::run_control::WaitingMessage;
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::session::run::engine::tests::{SETTLE_WAIT, insert_running_run, test_engine};
use crate::session::run::engine::{InterruptRoute, RunEngine};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::{RunStateChange, RunStateEntry};
use crate::uuid_v7::mint_uuid_v7;

/// The statements the control's read pool prepares: the run and its provider.
const READ_STATEMENT_CAPACITY: usize = 2;

/// How long a call held behind a resume is watched to show it waits.
const HELD_WATCH: Duration = Duration::from_millis(200);

/// A run bound to the table's first provider, the engine that moves it and the control under test.
struct Fixture {
    database: TestDatabase,
    engine: Arc<RunEngine>,
    control: RunPauseControl,
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

async fn fixture(driver: MockProviderDriver, state: &str) -> Fixture {
    let database = TestDatabase::new();
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
            READ_STATEMENT_CAPACITY,
        )),
        Arc::clone(&engine),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
    );
    Fixture {
        database,
        engine,
        control,
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

/// The driver's answer when the request went out and no answer came.
fn unanswered() -> DriverError {
    DriverError::Unanswered(RequestUnanswered {
        refusal: DomainError::new("the provider did not answer", RefusalCode::ProviderTimeout),
    })
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
#[derive(Default)]
struct WaitingMessages {
    waiting: Mutex<Vec<WaitingMessage>>,
    kept: Mutex<Vec<WaitingMessage>>,
    releases: AtomicUsize,
    admissions: AtomicUsize,
    // A read the test holds: it signals when it starts, then waits for the test to let it go.
    held_read: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

impl WaitingMessages {
    fn holding(message: WaitingMessage) -> Self {
        Self {
            waiting: Mutex::new(vec![message]),
            ..Self::default()
        }
    }

    fn kept(&self) -> Vec<WaitingMessage> {
        self.kept.lock().expect("the kept messages read").clone()
    }
}

impl ContinuedMessages for WaitingMessages {
    fn read(
        &self,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>> {
        let waiting = self.waiting.lock().expect("the messages read").clone();
        let held = self.held_read.lock().expect("the held read reads").take();
        async move {
            if let Some((started, let_go)) = held {
                started.send(()).expect("the test waits for the read");
                let_go.await.expect("the test lets the read go");
            }
            Ok(waiting)
        }
        .boxed()
    }

    fn admit(
        &self,
        _session_id: SessionId,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.waiting.lock().expect("the messages read").clear();
        self.admissions.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn release(
        &self,
        _session_id: SessionId,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn keep(&self, _run_id: RunId) {
        let mut waiting = self.waiting.lock().expect("the messages read");
        self.kept
            .lock()
            .expect("the kept messages read")
            .append(&mut waiting);
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
    assert_eq!(messages.kept(), []);
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
    assert_eq!(messages.kept(), kept);
    assert_eq!(messages.releases.load(Ordering::SeqCst), releases);
}

// A run a provider process's exit ended while its driver took the resume is not moved: one the
// exit left interrupted, a person's interrupt pending, answers that the version the caller read is
// stale, one it left stopped that it cannot move, each giving the messages back. Killed by moving
// the run before the driver, or by keeping the messages.
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
    assert_eq!(messages.releases.load(Ordering::SeqCst), 1);
    assert_eq!(messages.admissions.load(Ordering::SeqCst), 0);
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

// A provider's report that lands while a resume reads the waiting messages waits for the resume,
// which sends the messages once and moves the run to running; the driver is never asked and then
// overruled. Killed by holding the run as being resumed only after the messages are read: the
// report then moves the run, and the resume taken by the driver gives its messages back.
#[tokio::test]
async fn a_report_during_the_resumes_read_waits_and_the_resume_takes_the_run() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_run()
        .times(1)
        .returning(|_| async { Ok(()) }.boxed());
    let fixture = Arc::new(fixture(driver, "pausing").await);
    let (read_started, read_is_held) = oneshot::channel();
    let (let_read_go, read_let_go) = oneshot::channel();
    let messages = Arc::new(WaitingMessages {
        held_read: Mutex::new(Some((read_started, read_let_go))),
        ..WaitingMessages::holding(waiting_message())
    });

    let resuming = {
        let fixture = Arc::clone(&fixture);
        let messages = Arc::clone(&messages);
        tokio::spawn(async move { fixture.resume(1, messages.as_ref()).await })
    };
    tokio::time::timeout(SETTLE_WAIT, read_is_held)
        .await
        .expect("the resume reads the waiting messages")
        .expect("the read signals its start");
    let mut report = fixture.report(RunStateEntry::Paused);
    let is_report_held = tokio::time::timeout(HELD_WATCH, &mut report).await.is_err();
    let_read_go.send(()).expect("the read waits to be let go");
    let resumed = resuming.await.expect("the resume ends");
    let is_report_applied = report.await.expect("the report ends");

    assert!(is_report_held);
    assert!(resumed.is_ok(), "{resumed:?}");
    assert!(!is_report_applied);
    assert_eq!(fixture.run(), ("running".to_owned(), 2));
    assert_eq!(messages.admissions.load(Ordering::SeqCst), 1);
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
}
