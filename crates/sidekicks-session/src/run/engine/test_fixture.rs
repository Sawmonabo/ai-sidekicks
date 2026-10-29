//! What the session's tests and other crates' tests share: an engine over a test database, with
//! no driver or the drivers a test gives it, a resolver of its runs' choices, a stand-in for the
//! open sessions' postures, the running runs and events they seed, and a read of a run's stored
//! state.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_workspace::run_setup_gates::RunSetupGate;

use crate::plan_holds::{NoPlanHolds, PlanHolds};
use crate::run::engine::{RUN_ENGINE_STATEMENT_CAPACITY, RunEngine, RunEngineDeps};
use crate::run::provider_choice::held::HeldChoiceAnswers;
use crate::run::provider_choice::{PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceResolver};
use crate::run::session_posture::SessionPostureSource;

/// An engine on `database`, appending through `event_log`, with no registered driver, no
/// interventions service, no plan holds and its posture files under `home`; a test makes the
/// tables its runs need.
pub fn test_engine(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
) -> Arc<RunEngine> {
    test_engine_with(database, event_log, home, Arc::new(NoPlanHolds), Vec::new())
}

/// [`test_engine`] whose runs' ends read and reopen the plans `plan_holds` holds, with
/// `setup_gates` registered after the posture gate, in order.
pub fn test_engine_with(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
    plan_holds: Arc<dyn PlanHolds>,
    setup_gates: Vec<Arc<dyn RunSetupGate>>,
) -> Arc<RunEngine> {
    let providers = ProviderRegistry::register_from(&[], &test_driver_services());
    build_test_engine(
        database,
        event_log,
        home,
        plan_holds,
        setup_gates,
        providers,
    )
}

/// [`test_engine`] whose runs reach their drivers through `providers`, with `setup_gates`
/// registered after the posture gate, in order.
pub fn test_engine_on(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
    providers: ProviderRegistry,
    setup_gates: Vec<Arc<dyn RunSetupGate>>,
) -> Arc<RunEngine> {
    build_test_engine(
        database,
        event_log,
        home,
        Arc::new(NoPlanHolds),
        setup_gates,
        providers,
    )
}

// The engine every test engine is: its parts over `database`, its posture files under `home`.
fn build_test_engine(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
    plan_holds: Arc<dyn PlanHolds>,
    setup_gates: Vec<Arc<dyn RunSetupGate>>,
    providers: ProviderRegistry,
) -> Arc<RunEngine> {
    let deps = RunEngineDeps {
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        )),
        event_log,
        execution_postures: Arc::new(ExecutionPostureService::new(
            home,
            home.join("session-token"),
        )),
        providers: Arc::new(providers),
        plan_holds,
        held_choice_answers: Arc::new(HeldChoiceAnswers::default()),
    };
    Arc::new_cyclic(|this| {
        let mut engine = RunEngine::new(deps, this.clone());
        for gate in setup_gates {
            engine.register_setup_gate(gate);
        }
        engine
    })
}

/// A resolver of the choices `engine`'s runs wait on, reading `database`, holding its answers in
/// the store `engine`'s run ends read, with no registered driver.
pub fn test_choices(
    database: &TestDatabase,
    engine: &Arc<RunEngine>,
) -> Arc<ProviderChoiceResolver> {
    Arc::new(ProviderChoiceResolver::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            PROVIDER_CHOICE_STATEMENT_CAPACITY,
        )),
        Arc::clone(engine),
        Arc::new(ProviderRegistry::register_from(
            &[],
            &test_driver_services(),
        )),
        Arc::clone(engine.held_choice_answers()),
    ))
}

/// A stand-in for the open sessions' postures: every session reads as open at the one posture the
/// test last moved it to, and none reads as open before the first move.
#[derive(Default)]
pub struct TestSessionPostures {
    posture: Mutex<Option<ExecutionPosture>>,
}

impl TestSessionPostures {
    /// Has every session read as open at `posture` from now on.
    pub fn move_to(&self, posture: ExecutionPosture) {
        *lock(&self.posture) = Some(posture);
    }
}

impl SessionPostureSource for TestSessionPostures {
    fn opened_execution_posture(&self, _session_id: &SessionId) -> Option<ExecutionPosture> {
        lock(&self.posture).clone()
    }
}

/// Writes `run_id` of `session_id` running at version 1.
pub fn insert_running_run(database: &TestDatabase, session_id: SessionId, run_id: RunId) {
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
pub async fn append(engine: &RunEngine, session_id: SessionId, event: &SessionEvent) {
    engine
        .append(
            SessionEventDraft::of_session(session_id, event).expect("the event passes its checks"),
            Vec::new(),
            Vec::new(),
            None,
        )
        .await
        .expect("the test's event is appended");
}

/// The run's stored state and version.
pub fn stored_run_state(database: &TestDatabase, run_id: &RunId) -> (String, i64) {
    database
        .reader()
        .query_row(
            "SELECT state, run_version FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the run's row")
}

/// Ends `run_id` `stopped` in the database at `path`, as an end landing beside the engine's
/// writes.
#[cfg(test)]
pub(crate) fn end_run_aside(path: &Path, run_id: &RunId) {
    rusqlite::Connection::open(path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE runs SET state = 'stopped', run_version = run_version + 1
                 WHERE run_id = ?1",
                params![run_id.text().as_str()],
            )
        })
        .expect("the test ends the run");
}
