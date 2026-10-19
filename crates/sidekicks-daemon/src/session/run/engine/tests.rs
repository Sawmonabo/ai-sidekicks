//! What the engine's tests share: an engine over a test database with a stand-in interventions
//! service, the runs and events they seed, and reads of what a run stored.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::events::{AgentTurnCompletedPayload, AgentTurnStartedPayload};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{LimitInterruptRecord, RunLimit};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::DATABASE_NOW_SQL;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::SessionEventDraft;
use crate::pause_point::PausePoint;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::DriverServices;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::run::engine::limits::LimitStop;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::turns::{ProviderTurnEnd, StepCount, TurnOutcome};
use crate::session::run::engine::{RUN_ENGINE_STATEMENT_CAPACITY, RunEngine, RunEngineDeps};
use crate::session::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::session::run::start_request::{RunContinueRequest, RunTurnStart};
use crate::uuid_v7::mint_uuid_v7;

/// Bounds a start or a continue and the call made while its driver is held, so a call that waits
/// on nothing fails the test.
pub(super) const SETTLE_WAIT: Duration = Duration::from_secs(10);

/// How long a held driver stays held once the call under test is in flight, long enough for a
/// call that does not wait to read the run and act on what it reads.
pub(super) const DRIVER_HOLD: Duration = Duration::from_millis(200);

/// An engine on `database`, appending through `event_log`, with no registered driver, no
/// interventions service and its posture files under `home`; a test makes the tables its runs
/// need.
pub(crate) fn test_engine(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
) -> Arc<RunEngine> {
    let services = DriverServices {
        spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
        data_folder: PathBuf::from("data"),
    };
    Arc::new(RunEngine::new(RunEngineDeps {
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        )),
        event_log,
        execution_postures: Arc::new(ExecutionPostureService::new(
            home,
            home.join("session-token"),
        )),
        providers: Arc::new(ProviderRegistry::register_from(&[], &services)),
    }))
}

/// A stand-in interventions service that refuses the first limit interrupts it is handed, as many
/// as it was told, each leaving no pending row unless a test says otherwise, and accepts the rest,
/// leaving the run's end to the test; a hand the test holds waits for the test's answer instead.
/// Once a test hands it the database, every interrupt it accepts, or refuses with its row pending,
/// records its row `accepted` with the turn it names.
pub(super) struct TestLimitInterrupter {
    refusals_left: AtomicUsize,
    is_refused_row_pending: AtomicBool,
    row_database: OnceLock<PathBuf>,
    /// Where a hand the test armed a hold for waits, in the order the hands arrive, for the test's
    /// answer: whether the stand-in refuses it, leaving no row.
    pub(super) held_hands: PausePoint<bool>,
    /// How many interrupts it was handed.
    pub(super) calls: AtomicUsize,
    /// The turn each interrupt it was handed names, in order.
    pub(super) cut_turns: Mutex<Vec<Option<SafeInt<1>>>>,
}

impl TestLimitInterrupter {
    /// Has every later refusal leave its row pending.
    pub(super) fn refuse_with_row_pending(&self) {
        self.is_refused_row_pending.store(true, Ordering::SeqCst);
    }

    /// Records each later row in `database`, whose interventions table the test made.
    pub(super) fn record_rows_in(&self, database: &TestDatabase) {
        assert!(
            self.row_database.set(database.path()).is_ok(),
            "the stand-in records its rows in one database"
        );
    }

    // Records the interrupt of `run_id` at `limit`, naming `cut_turn`, as an accepted row.
    fn record_row(&self, run_id: RunId, limit: RunLimit, cut_turn: Option<SafeInt<1>>) {
        let Some(path) = self.row_database.get() else {
            return;
        };
        let id = mint_uuid_v7().to_string();
        let record = serde_json::to_string(&LimitInterruptRecord {
            limit,
            turn_number: cut_turn,
        })
        .expect("a limit's record serializes");
        Connection::open(path)
            .and_then(|connection| {
                connection.execute(
                    &format!(
                        "INSERT INTO interventions (id, target_run_id, type, state, payload,
                           expected_run_version, client_idempotency_key, created_at)
                         VALUES (?1, ?2, 'interrupt', 'accepted', ?3, 1, ?1, {DATABASE_NOW_SQL})"
                    ),
                    params![id, run_id.text().as_str(), record],
                )
            })
            .expect("the stand-in records the limit's interrupt");
    }
}

impl LimitInterrupter for TestLimitInterrupter {
    fn interrupt_for_limit(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
    ) -> BoxFuture<'_, Result<(), LimitInterruptFailure>> {
        let cut_turn = cut.map(|cut| cut.turn_number);
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.cut_turns
            .lock()
            .expect("the stand-in's turns are not poisoned")
            .push(cut_turn);
        async move {
            let (is_refused, is_row_pending) = match self.held_hands.pass().await {
                Some(is_refused) => (is_refused, false),
                None => (
                    self.refusals_left
                        .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                            left.checked_sub(1)
                        })
                        .is_ok(),
                    self.is_refused_row_pending.load(Ordering::SeqCst),
                ),
            };
            if !is_refused || is_row_pending {
                self.record_row(run_id, limit, cut_turn);
            }
            let source = "the test's interventions service refuses the interrupt".into();
            match (is_refused, is_row_pending) {
                (false, _) => Ok(()),
                (true, false) => Err(LimitInterruptFailure::NoRow { source }),
                (true, true) => Err(LimitInterruptFailure::RowPending { source }),
            }
        }
        .boxed()
    }
}

/// Hands `engine` a stand-in interventions service that refuses its first `refusals` interrupts;
/// the engine holds it only while the caller keeps the returned handle.
pub(super) fn hand_limit_interrupter(
    engine: &RunEngine,
    refusals: usize,
) -> Arc<TestLimitInterrupter> {
    let interrupter = Arc::new(TestLimitInterrupter {
        refusals_left: AtomicUsize::new(refusals),
        is_refused_row_pending: AtomicBool::new(false),
        row_database: OnceLock::new(),
        held_hands: PausePoint::default(),
        calls: AtomicUsize::new(0),
        cut_turns: Mutex::new(Vec::new()),
    });
    let handed: Weak<TestLimitInterrupter> = Arc::downgrade(&interrupter);
    assert!(
        engine.set_limit_interrupter(handed).is_ok(),
        "the engine is handed one interventions service"
    );
    interrupter
}

/// Writes `run_id` of `session_id` running at version 1.
pub(crate) fn insert_running_run(database: &TestDatabase, session_id: SessionId, run_id: RunId) {
    let connection = database.reader();
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'running', 1)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the test writes the run");
}

/// Appends `event` to the log of `session_id` through `engine`.
pub(super) async fn append(engine: &RunEngine, session_id: SessionId, event: &SessionEvent) {
    engine
        .append(
            SessionEventDraft::of_session(session_id, event).expect("the event passes its checks"),
            Vec::new(),
            Vec::new(),
        )
        .await
        .expect("the test's event is appended");
}

/// The step bound the tests' turns reach.
pub(super) const STEP_BOUND: SafeInt<1> = SafeInt::new(40).expect("40 is a step bound");

/// Arms the step count of turn `turn_number` on `run_id` at `bound`, as the turn's start does on a
/// run whose provider does not bound its steps.
pub(super) fn arm_step_count(engine: &RunEngine, run_id: RunId, turn_number: u64, bound: u64) {
    lock(&engine.live).step_counts.insert(
        run_id,
        StepCount::new(
            turn(turn_number),
            SafeInt::new(bound).expect("the test's step bounds count from 1"),
        ),
    );
}

/// A test's turn number.
pub(super) fn turn(number: u64) -> SafeInt<1> {
    SafeInt::new(number).expect("the test's turn numbers count from 1")
}

/// The step stop of turn `turn_number` at its bound.
pub(super) fn step_stop(turn_number: u64) -> LimitStop {
    LimitStop::Step {
        count: STEP_BOUND,
        turn_number: turn(turn_number),
    }
}

/// The provider's end of turn `turn_number`, interrupted with no cause of its own.
pub(super) fn provider_end(turn_number: u64) -> ProviderTurnEnd {
    ProviderTurnEnd {
        turn_number: turn(turn_number),
        outcome: TurnOutcome::Interrupted(None),
    }
}

/// A test's run version.
pub(super) fn run_version(version: u64) -> SafeInt<0> {
    SafeInt::new(version).expect("the test's run versions are safe integers")
}

/// The start of turn `turn_number` of `run_id` at run version `version`.
pub(super) fn turn_started_at(
    session_id: SessionId,
    run_id: RunId,
    turn_number: u64,
    version: u64,
) -> SessionEvent {
    SessionEvent::AgentTurnStarted(AgentTurnStartedPayload {
        session_id,
        run_id,
        run_version: run_version(version),
        turn_number: turn(turn_number),
        position: None,
    })
}

/// The completion of turn `turn_number` of `run_id` at run version `version`.
pub(super) fn turn_completed_at(
    session_id: SessionId,
    run_id: RunId,
    turn_number: u64,
    version: u64,
) -> SessionEvent {
    SessionEvent::AgentTurnCompleted(AgentTurnCompletedPayload {
        session_id,
        run_id,
        run_version: run_version(version),
        turn_number: turn(turn_number),
    })
}

/// The run's stored events in order: each type, with the payload's `cause` and `origin`.
pub(super) fn stored_events(
    database: &TestDatabase,
    run_id: &RunId,
) -> Vec<(String, Option<String>, Option<String>)> {
    database
        .reader()
        .prepare("SELECT type, payload FROM session_events WHERE run_id = ?1 ORDER BY sequence")
        .expect("the test reads the run's events")
        .query_map([run_id.text().as_str()], |row| {
            let payload: String = row.get(1)?;
            let payload: Value = serde_json::from_str(&payload).expect("a stored payload is JSON");
            let text = |member: &str| payload[member].as_str().map(str::to_owned);
            Ok((row.get(0)?, text("cause"), text("origin")))
        })
        .expect("the run's events read")
        .collect::<Result<_, _>>()
        .expect("each event reads")
}

/// `expected` in the form [`stored_events`] reads.
pub(super) fn events(
    expected: &[(&str, Option<&str>, Option<&str>)],
) -> Vec<(String, Option<String>, Option<String>)> {
    expected
        .iter()
        .map(|(event_type, cause, origin)| {
            (
                (*event_type).to_owned(),
                cause.map(str::to_owned),
                origin.map(str::to_owned),
            )
        })
        .collect()
}

/// A test's token limit.
pub(super) fn token_limit() -> TokensPerRun {
    TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer"))
}

/// Cuts turn `turn_number` of `run_id` at `limit` as a stop does before it hands the interrupt,
/// and answers the cut as the hand carries it.
pub(crate) fn hold_cut(
    engine: &RunEngine,
    run_id: RunId,
    turn_number: SafeInt<1>,
    limit: RunLimit,
) -> HandedCut {
    let mut live = lock(&engine.live);
    let cut = live.new_cut(limit);
    live.cut_turns
        .entry((run_id, turn_number))
        .or_default()
        .push(cut);
    HandedCut {
        turn_number,
        stop_id: cut.stop_id,
    }
}

/// The limit turn `turn_number` of `run_id` ends with by the cuts the engine holds of it, if any.
pub(crate) fn held_cut_limit(
    engine: &RunEngine,
    run_id: RunId,
    turn_number: SafeInt<1>,
) -> Option<RunLimit> {
    lock(&engine.live).current_limit(&(run_id, turn_number))
}

/// The run's stored state and version.
pub(crate) fn stored_run_state(database: &TestDatabase, run_id: &RunId) -> (String, i64) {
    database
        .reader()
        .query_row(
            "SELECT state, run_version FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the run's row")
}

/// A turn start of `run_id`, read-only at the root, whose driver starts the turn as `start_driver`
/// does and whose turn interrupt succeeds at once.
pub(super) fn turn_start(
    run_id: RunId,
    start_driver: impl Fn(
        ExecutionPosture,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>
    + Send
    + Sync
    + 'static,
) -> RunTurnStart {
    RunTurnStart {
        run_id,
        workspace_id: None,
        execution_posture: compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        ),
        start_driver: Box::new(start_driver),
        interrupt_driver: Box::new(|| async { Ok(()) }.boxed()),
    }
}

/// A continue of the interrupted `run_id` from an admitted message, its turn started as
/// [`turn_start`] starts it.
pub(super) fn continue_request(
    run_id: RunId,
    start_driver: impl Fn(
        ExecutionPosture,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>
    + Send
    + Sync
    + 'static,
) -> RunContinueRequest {
    let queue_item = serde_json::from_value(json!({
        "state": "admitted",
        "id": mint_uuid_v7().to_string(),
        "position": 0,
        "content": "Go on.",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }))
    .expect("the test's message reads as an admitted item");
    RunContinueRequest {
        turn: turn_start(run_id, start_driver),
        queue_item,
    }
}

/// A driver start that starts the turn at once.
pub(super) fn started_turn(
    _resolved_posture: ExecutionPosture,
) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
    async { Ok(()) }.boxed()
}

/// A driver start that is held once it begins: the start, which reports on the receiver that it
/// began and then waits until the sender releases it. It starts one turn.
pub(super) fn held_driver() -> (
    impl Fn(ExecutionPosture) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>
    + Send
    + Sync
    + 'static,
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
) {
    let (driver_started, driver_has_started) = oneshot::channel::<()>();
    let (release_driver, driver_released) = oneshot::channel::<()>();
    let held = Mutex::new(Some((driver_started, driver_released)));
    let start_driver = move |_resolved_posture: ExecutionPosture| {
        let (started, released) = held
            .lock()
            .expect("the test's driver is not poisoned")
            .take()
            .expect("the driver starts one turn");
        async move {
            started
                .send(())
                .expect("the test waits for the driver's start");
            released.await?;
            Ok::<(), Box<dyn Error + Send + Sync>>(())
        }
        .boxed()
    };
    (start_driver, driver_has_started, release_driver)
}
