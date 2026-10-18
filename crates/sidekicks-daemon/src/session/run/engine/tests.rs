//! What the engine's tests share: an engine over a test database, and reads of what a run stored.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::EventLogService;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::provider::driver::DriverServices;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::run::engine::{RUN_ENGINE_STATEMENT_CAPACITY, RunEngine, RunEngineDeps};

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

/// The run's stored events in order: each type, with the payload's `cause`.
pub(super) fn stored_events(
    database: &TestDatabase,
    run_id: &RunId,
) -> Vec<(String, Option<String>)> {
    database
        .reader()
        .prepare("SELECT type, payload FROM session_events WHERE run_id = ?1 ORDER BY sequence")
        .expect("the test reads the run's events")
        .query_map([run_id.text().as_str()], |row| {
            let payload: String = row.get(1)?;
            let payload: Value = serde_json::from_str(&payload).expect("a stored payload is JSON");
            Ok((row.get(0)?, payload["cause"].as_str().map(str::to_owned)))
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
