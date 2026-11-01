//! What the engine's tests and the session's other tests share: a stand-in interventions service,
//! the turns, events and limits they build, the cuts they hold, and the driver starts they run.

use std::error::Error;
use std::path::PathBuf;
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
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::run::start_request::DriverStep;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::pause_point::PausePoint;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::oneshot;

use crate::run::engine::RunEngine;
use crate::run::engine::limits::LimitStop;
use crate::run::engine::turns::StepCount;
use crate::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::run::start_request::{RunContinueRequest, RunTurnStart};

/// Bounds a start or a continue, the call made while its driver is held and a hand on a task of
/// its own, so a call that waits on nothing, or a hand that never comes, fails the test.
pub(crate) const SETTLE_WAIT: Duration = Duration::from_secs(10);

/// How long a held driver stays held once the call under test is in flight, long enough for a
/// call that does not wait to read the run and act on what it reads.
pub(crate) const DRIVER_HOLD: Duration = Duration::from_millis(200);

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
pub(crate) fn turn_started_at(
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
        provider_turn_id: None,
    })
}

/// The completion of turn `turn_number` of `run_id` at run version `version`.
pub(crate) fn turn_completed_at(
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

/// A turn start of `run_id`, read-only at the root, whose driver starts the turn as `start_driver`
/// does and whose turn interrupt succeeds at once.
pub(super) fn turn_start(
    run_id: RunId,
    start_driver: impl Fn(ExecutionPosture) -> DriverStep + Send + Sync + 'static,
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
pub(crate) fn continue_request(
    run_id: RunId,
    start_driver: impl Fn(ExecutionPosture) -> DriverStep + Send + Sync + 'static,
) -> RunContinueRequest {
    let queue_item = serde_json::from_value(json!({
        "kind": "message",
        "state": "admitted",
        "id": mint_uuid_v7().to_string(),
        "position": 0,
        "isSentNow": false,
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
pub(super) fn started_turn(_resolved_posture: ExecutionPosture) -> DriverStep {
    async { Ok(()) }.boxed()
}

/// A driver start that is held once it begins: the start, which reports on the receiver that it
/// began and then waits until the sender releases it. It starts one turn.
pub(crate) fn held_driver() -> (
    impl Fn(ExecutionPosture) -> DriverStep + Send + Sync + 'static,
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
