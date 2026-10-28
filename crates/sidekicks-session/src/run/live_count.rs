//! How many runs are live: in `starting`, `running` or `pausing`, the states in which a run does
//! work, in a session whose history the daemon trusts. A run waiting on a person, paused or ended
//! does none, and neither does a run of a session whose projections are not current: the restart
//! ended its process and only a rebuild or a delete settles it. The database writer counts after
//! each commit, so the count moves in commit order; keep-awake, the scheduler's condition and the
//! repack follow it.

use std::sync::LazyLock;

use rusqlite::Connection;
use sidekicks_contracts::run::state::RunState;
use sidekicks_store::database::schema::recovery::ProjectionCursorState;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::writer::CommitRead;
use strum::VariantArray as _;
use tokio::sync::watch;

use crate::run::transitions::RUN_TERMINAL_STATES_SQL;

// The live runs of the sessions whose cursor is current. The terminal-state term lets the count
// search the live runs' covering index rather than read the whole table.
static LIVE_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    let live_states = sql_list_of(
        RunState::VARIANTS
            .iter()
            .copied()
            .filter(|state| is_live(*state))
            .map(<&'static str>::from),
    );
    format!(
        "SELECT count(*) FROM runs
  WHERE state NOT IN ({terminal_states}) AND state IN ({live_states})
    AND NOT EXISTS (
      SELECT 1 FROM projection_cursors
      WHERE session_id = runs.session_id AND state <> ?1
    )",
        terminal_states = *RUN_TERMINAL_STATES_SQL,
    )
});

/// The read the database writer runs after each commit to count the live runs, and a receiver of
/// that count, which sees its current value and every change.
pub fn count_live_runs_after_commits() -> (CommitRead, watch::Receiver<u32>) {
    let (count, receiver) = watch::channel(0);
    let read: CommitRead = Box::new(move |connection: &Connection| {
        let live_runs: u32 = connection
            .prepare_cached(LIVE_RUNS_SQL.as_str())?
            .query_row([<&str>::from(ProjectionCursorState::Current)], |row| {
                row.get(0)
            })?;
        count.send_if_modified(|counted| {
            let is_moved = *counted != live_runs;
            *counted = live_runs;
            is_moved
        });
        Ok(())
    });
    (read, receiver)
}

/// Whether a run in `state` does work.
fn is_live(state: RunState) -> bool {
    match state {
        RunState::Starting | RunState::Running | RunState::Pausing => true,
        RunState::Queued
        | RunState::WaitingForApproval
        | RunState::WaitingForInput
        | RunState::Paused
        | RunState::Completed
        | RunState::Interrupted
        | RunState::Stopped
        | RunState::Failed => false,
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
#[cfg(test)]
mod tests;
