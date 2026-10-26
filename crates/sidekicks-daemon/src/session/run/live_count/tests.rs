//! The writer's count of live runs, moved by each commit in commit order.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use tokio::sync::watch;

use super::count_live_runs_after_commits;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::tests::{TestLog, open_log_with};
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::questions::schema::schema_parts;
use crate::session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeWriter, RunStateEntry,
};

/// The event log on a fresh database, its writer counting the live runs after each commit, and
/// that count.
pub(crate) async fn counted_log(database: &TestDatabase) -> (TestLog, watch::Receiver<u32>) {
    let (after_commit, live_runs) = count_live_runs_after_commits();
    let options = DatabaseWriterOptions {
        after_commit: Some(after_commit),
        ..DatabaseWriterOptions::default()
    };
    (open_log_with(database, options).await, live_runs)
}

// Commits run `run_id` of a fresh session in `state` through `writer`, as a run state change's
// write leaves the run's row.
async fn commit_run_state(writer: &DatabaseWriter, run_id: RunId, state: RunState) {
    let statement = WriteStatement {
        sql: Cow::Borrowed(
            "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT (run_id) DO UPDATE SET state = excluded.state",
        ),
        bindings: StatementBindings::Positional(vec![
            Value::Text(run_id.text().as_str().to_owned()),
            Value::Text(test_session_id().text().as_str().to_owned()),
            Value::Text(<&str>::from(state).to_owned()),
        ]),
        expected_row_count: Some(1),
    };
    writer
        .write(vec![statement])
        .await
        .expect("the test's run state commits");
}

// A run committed `starting` counts as live from that commit, and its end leaves the count at zero,
// the count the scheduler's idle jobs and the repack wait on. Killed by `starting` missing from
// the live set and by an ended run still counted.
#[tokio::test]
async fn a_starting_run_counts_until_it_ends() {
    let database = TestDatabase::new(schema_parts());
    let (log, count) = counted_log(&database).await;
    let run_id = test_run_id();

    commit_run_state(&log.writer, run_id, RunState::Starting).await;
    assert_eq!(*count.borrow(), 1);
    commit_run_state(&log.writer, run_id, RunState::Completed).await;
    assert_eq!(*count.borrow(), 0);
}

// Each committed change moves the count by the states it leaves and enters, read after its commit:
// `pausing` stays live, `paused` and a wait on a person leave it, a return to `running` enters it,
// and a refused change moves nothing, whether its state was refused or a companion statement
// refused it after the state's swap ran. Killed by a state missing from the live set, by a wait
// counted as live, and by a count read before the commit or after a write that rolled back.
#[tokio::test]
async fn committed_changes_move_the_count_by_the_states_they_leave_and_enter() {
    let database = TestDatabase::new(schema_parts());
    let (log, count) = counted_log(&database).await;
    let session_id = test_session_id();
    let run_id = test_run_id();
    insert_running_run(&database, session_id, run_id);
    // Written past the writer, so no commit has counted it yet.
    assert_eq!(*count.borrow(), 0);

    let changes = RunStateChangeWriter::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        )),
        Arc::new(SessionEventAppender::new(
            log.service,
            SESSION_EVENT_VERSION.clone(),
        )),
    );
    let running = RunStateEntry::Running {
        execution_posture: None,
    };
    // A companion that changes no row where it expects one, so it refuses the write after the
    // state's swap ran.
    let refusing = || RunStateChangeCompanions {
        statements: vec![WriteStatement {
            sql: Cow::Borrowed("UPDATE runs SET state = state WHERE 0"),
            bindings: StatementBindings::None,
            expected_row_count: Some(1),
        }],
        ..RunStateChangeCompanions::default()
    };
    let steps = [
        (RunStateEntry::Pausing, Ok(RunState::Pausing), 1, false),
        (RunStateEntry::Paused, Ok(RunState::Paused), 0, false),
        // A paused run cannot pause again, so the change is refused and nothing moves.
        (RunStateEntry::Pausing, Err(()), 0, false),
        (running.clone(), Ok(RunState::Running), 1, false),
        (RunStateEntry::WaitingForApproval, Err(()), 1, true),
        (
            RunStateEntry::WaitingForApproval,
            Ok(RunState::WaitingForApproval),
            0,
            false,
        ),
        (running, Ok(RunState::Running), 1, false),
    ];
    for (entry, expected, expected_count, is_companion_refused) in steps {
        let companions = if is_companion_refused {
            refusing()
        } else {
            RunStateChangeCompanions::default()
        };
        let written = changes
            .write(RunStateChange::new(run_id, entry.clone()), companions, None)
            .await
            .map(|run| run.state)
            .map_err(|_refused| ());
        assert_eq!(written, expected, "{entry:?}");
        assert_eq!(*count.borrow(), expected_count, "{entry:?}");
    }
}
