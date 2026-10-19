//! What the engine's tests share: an engine over a test database with a stand-in interventions
//! service, the runs and events they seed, and reads of what a run stored.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::AgentTurnStartedPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::SessionEventDraft;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::provider::driver::DriverServices;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::run::engine::{RUN_ENGINE_STATEMENT_CAPACITY, RunEngine, RunEngineDeps};
use crate::session::run::limit_interrupter::LimitInterrupter;
use crate::session::run::projection::RUNS_TABLE_SQL;

/// An engine on `database`, appending through `event_log`, with no registered driver, no
/// interventions service and its posture files under `home`; a test makes the tables its runs
/// need.
pub(super) fn test_engine(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
) -> RunEngine {
    let services = DriverServices {
        spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
        data_folder: PathBuf::from("data"),
    };
    RunEngine::new(RunEngineDeps {
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
    })
}

/// A stand-in interventions service that refuses the first limit interrupts it is handed, as many
/// as it was told, and accepts the rest, leaving the run's end to the test.
pub(super) struct TestLimitInterrupter {
    refusals_left: AtomicUsize,
    /// How many interrupts it was handed.
    pub(super) calls: AtomicUsize,
}

impl LimitInterrupter for TestLimitInterrupter {
    fn interrupt_for_limit(
        &self,
        _run_id: RunId,
        _limit: RunLimit,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let is_refused = self
            .refusals_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        async move {
            if is_refused {
                Err("the test's interventions service refuses the interrupt".into())
            } else {
                Ok(())
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
        calls: AtomicUsize::new(0),
    });
    let handed: Weak<dyn LimitInterrupter> = Arc::downgrade(&interrupter);
    assert!(
        engine.set_limit_interrupter(handed).is_ok(),
        "the engine is handed one interventions service"
    );
    interrupter
}

/// Makes the runs table and writes `run_id` of `session_id` running at version 1.
pub(super) fn insert_running_run(database: &TestDatabase, session_id: SessionId, run_id: RunId) {
    let connection = database.reader();
    connection
        .execute_batch(RUNS_TABLE_SQL)
        .expect("the test makes the runs table");
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

/// A test's run version.
pub(super) fn run_version(version: u64) -> SafeInt<0> {
    SafeInt::new(version).expect("the test's run versions are safe integers")
}

/// The start of turn `turn` of `run_id` at run version `version`.
pub(super) fn turn_started_at(
    session_id: SessionId,
    run_id: RunId,
    turn: u64,
    version: u64,
) -> SessionEvent {
    SessionEvent::AgentTurnStarted(AgentTurnStartedPayload {
        session_id,
        run_id,
        run_version: run_version(version),
        turn_number: SafeInt::new(turn).expect("the test's turn numbers count from 1"),
        position: None,
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

/// The run's stored state and version.
pub(super) fn stored_run_state(database: &TestDatabase, run_id: &RunId) -> (String, i64) {
    database
        .reader()
        .query_row(
            "SELECT state, run_version FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the run's row")
}
