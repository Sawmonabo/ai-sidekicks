//! The count of live runs, moved by committed run state changes.

use std::borrow::Cow;
use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use strum::VariantArray as _;

use super::LiveRunCount;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeWriter, RunStateEntry,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;

// The seed reads the live runs at start, and each committed change moves the count by the states
// it leaves and enters: `pausing` stays live, `paused` and a wait on a person leave it, a return
// to `running` enters it, and a refused change moves nothing, whether its state was refused or a
// companion statement refused it after the state's swap ran. Killed by a state missing from the
// live set, by a wait counted as live, by a count moved without a commit, and by one moved at the
// swap, before the commit.
#[tokio::test]
async fn committed_changes_move_the_count_by_the_states_they_leave_and_enter() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let live_runs = Arc::new(LiveRunCount::default());
    let count = live_runs.follow();
    live_runs
        .seed(&database.reader())
        .expect("the runs table reads");
    assert_eq!(*count.borrow(), 1);

    let changes = RunStateChangeWriter::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        )),
        Arc::new(SessionEventAppender::new(
            log.service,
            SESSION_EVENT_VERSION.clone(),
        )),
        Arc::clone(&live_runs),
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

// Every move between two states the table lists, one live and one not, counts once, and a move
// between two of one kind counts none. Killed by any state put in the wrong set.
#[test]
fn only_a_move_across_the_live_set_counts() {
    let live = [RunState::Starting, RunState::Running, RunState::Pausing];
    for previous in RunState::VARIANTS {
        for new in RunState::VARIANTS {
            let count = LiveRunCount::default();
            count.count.send_replace(5);
            count.record(*previous, *new);
            let expected = match (live.contains(previous), live.contains(new)) {
                (false, true) => 6,
                (true, false) => 4,
                (true, true) | (false, false) => 5,
            };
            assert_eq!(
                *count.follow().borrow(),
                expected,
                "{previous:?} to {new:?}"
            );
        }
    }
}
