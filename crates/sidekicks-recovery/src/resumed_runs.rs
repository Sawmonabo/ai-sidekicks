//! The runs a session's resume named, settled as the provider answered for each before the resumed
//! binding is recorded: each run the answer names that is still live is finalized from the state
//! it was stored in before the restart, and a live run the answer leaves out is left to the restart
//! settle.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_queue::provider_session::resumed_runs::{ResumedRuns, ResumedRunsIngress};
use sidekicks_session::run::engine::{RunEngine, RunEngineError};
use sidekicks_session::run::read::RunStateReader;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

/// The statements the finalize's own reads run: the one-session listing of its live runs.
pub const RESUMED_RUNS_STATEMENT_CAPACITY: usize = 1;

/// What the resumed runs' finalize reads and writes through.
pub struct ResumedRunsFinalizeDeps {
    /// The read of the session's live runs.
    pub reads: Arc<DatabaseReadPool>,
    /// The finalize of each run.
    pub run_engine: Arc<RunEngine>,
}

/// Finalizes each run a session's resume named as the provider answered for it.
pub struct ResumedRunsFinalize {
    deps: ResumedRunsFinalizeDeps,
}

/// Why the runs a resume named were not all finalized; what was finalized before is kept.
#[derive(Debug, thiserror::Error)]
pub enum ResumedRunsFinalizeError {
    /// SQLite refused the read of the session's live runs.
    #[error("the session's live runs could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read of the session's live runs.
    #[error("the session's live runs could not be read")]
    Pool(#[from] DatabaseReadError),
    /// A run could not be finalized.
    #[error("a run the resume named could not be finalized")]
    Run(#[from] RunEngineError),
}

impl ResumedRunsFinalize {
    /// A finalize over `deps`.
    pub fn new(deps: ResumedRunsFinalizeDeps) -> Self {
        Self { deps }
    }

    /// Finalizes each run of `resumed` the session still holds live, in the answer's order, from
    /// the state it is stored in, which nothing moves before the resumed binding is recorded, and
    /// the provider's answer for it; a named run that has ended is skipped. Writes take the
    /// session's append hold themselves, since the caller holds only its transition lock. Fails
    /// at the read or the first finalize that fails.
    pub async fn finalize(&self, resumed: ResumedRuns) -> Result<(), ResumedRunsFinalizeError> {
        let session_id = resumed.session_id;
        let live_runs = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ResumedRunsFinalizeError>(
                    RunStateReader::new(reader).list_live_runs(Some(&session_id))?,
                )
            })
            .await?;
        for answer in resumed.runs {
            let Some(live_run) = live_runs.iter().find(|live| live.run_id == answer.run_id) else {
                continue;
            };
            self.deps
                .run_engine
                .finalize_resumed_run(live_run, live_run.run.state, answer.turn, None)
                .await?;
        }
        Ok(())
    }
}

impl ResumedRunsIngress for ResumedRunsFinalize {
    fn take_resumed_runs(
        &self,
        resumed: ResumedRuns,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move { self.finalize(resumed).await.map_err(Into::into) }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_provider::driver::session_control::{ProviderTurnAnswer, ResumedRunAnswer};
    use sidekicks_queue::provider_session::resumed_runs::ResumedRuns;
    use sidekicks_session::questions::schema::schema_parts;
    use sidekicks_session::run::engine::test_fixture::{
        append, insert_running_run, stored_run_state, test_engine,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_run_id, test_session_id,
    };
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::{RESUMED_RUNS_STATEMENT_CAPACITY, ResumedRunsFinalize, ResumedRunsFinalizeDeps};

    // The events of `run_id` in the log, by type, in log order.
    fn event_types(database: &TestDatabase, run_id: RunId) -> Vec<String> {
        database
            .reader()
            .prepare("SELECT type FROM session_events WHERE run_id = ?1 ORDER BY sequence")
            .expect("the test reads the log")
            .query_map([run_id.text().as_str()], |row| row.get(0))
            .expect("the log reads")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }

    // Each run the answer names is finalized from its own answer: a running run whose turn is gone
    // ends `interrupted` by `daemonRestart`, one whose turn still runs stays `running`, a named run
    // the session no longer holds live is skipped, and a live run the answer leaves out is
    // untouched. Killed by the finalize handed a fixed `Gone` (the still-running run ends), by a
    // named run that has ended failing the whole ingress, and by an unnamed run finalized.
    #[tokio::test]
    async fn each_named_run_is_finalized_from_its_own_answer() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let engine = test_engine(&database, log.service, home.path());
        let session_id = test_session_id();
        let (gone, still_running, unnamed, ended) =
            (test_run_id(), test_run_id(), test_run_id(), test_run_id());
        for run_id in [gone, still_running, unnamed] {
            insert_running_run(&database, session_id, run_id);
            let started: SessionEvent = serde_json::from_value(json!({
                "type": "agent.turn.started",
                "payload": {
                    "sessionId": session_id,
                    "runId": run_id,
                    "runVersion": 1,
                    "turnNumber": 1,
                },
            }))
            .expect("the test's turn start reads as an event");
            append(&engine, session_id, &started).await;
        }
        let finalize = ResumedRunsFinalize::new(ResumedRunsFinalizeDeps {
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                RESUMED_RUNS_STATEMENT_CAPACITY,
            )),
            run_engine: engine,
        });
        let answer = |run_id, turn| ResumedRunAnswer { run_id, turn };

        finalize
            .finalize(ResumedRuns {
                session_id,
                runs: vec![
                    answer(ended, ProviderTurnAnswer::Gone),
                    answer(gone, ProviderTurnAnswer::Gone),
                    answer(still_running, ProviderTurnAnswer::StillRunning),
                ],
            })
            .await
            .expect("the named runs are finalized");

        assert_eq!(stored_run_state(&database, &gone).0, "interrupted");
        let trigger: String = database
            .reader()
            .query_row(
                "SELECT json_extract(payload, '$.trigger') FROM session_events
                  WHERE run_id = ?1 AND type = 'agent.run.interrupted'",
                [gone.text().as_str()],
                |row| row.get(0),
            )
            .expect("the gone run's end reads");
        assert_eq!(trigger, "daemonRestart");
        for left in [still_running, unnamed] {
            assert_eq!(
                stored_run_state(&database, &left),
                ("running".to_owned(), 1)
            );
            assert_eq!(event_types(&database, left), ["agent.turn.started"]);
        }
    }
}
