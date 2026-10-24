//! How many runs are live: in `starting`, `running` or `pausing`, the states in which a run does
//! work. A run waiting on a person, paused or ended does none. The count is read once from the
//! runs table at start, after every write the start's own recovery makes and before the engine
//! takes a run, then moved by each run state change once its write commits; keep-awake and the
//! scheduler's condition both follow it.

use rusqlite::Connection;
use sidekicks_contracts::run::state::RunState;
use tokio::sync::watch;

// The live runs in the runs table, read once at start.
const LIVE_RUNS_SQL: &str =
    "SELECT count(*) FROM runs WHERE state IN ('starting', 'running', 'pausing')";

/// The daemon's one count of live runs, which every committed run state change moves and any
/// number of readers follow.
#[derive(Debug)]
pub(crate) struct LiveRunCount {
    count: watch::Sender<u32>,
}

impl Default for LiveRunCount {
    fn default() -> Self {
        Self {
            count: watch::Sender::new(0),
        }
    }
}

impl LiveRunCount {
    /// Sets the count from the runs table on `reader`. Read at start once the runs projection's
    /// rebuild and the restart's recovery have written, and before the engine takes a run, so no
    /// move is counted twice; fails when SQLite refuses the read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start, which seeds the count")
    )]
    pub(crate) fn seed(&self, reader: &Connection) -> rusqlite::Result<()> {
        let count: u32 = reader.query_row(LIVE_RUNS_SQL, [], |row| row.get(0))?;
        self.count.send_replace(count);
        Ok(())
    }

    /// A receiver of the count, which sees its current value and every later one.
    pub(crate) fn follow(&self) -> watch::Receiver<u32> {
        self.count.subscribe()
    }

    /// Moves the count for one committed change of a run from `previous` to `new`: one more on
    /// entering a live state, one fewer on leaving one, none between two of either.
    pub(crate) fn record(&self, previous: RunState, new: RunState) {
        match (is_live(previous), is_live(new)) {
            (false, true) => {
                self.count
                    .send_modify(|count| *count = count.saturating_add(1));
            }
            (true, false) => {
                self.count
                    .send_modify(|count| *count = count.saturating_sub(1));
            }
            (true, true) | (false, false) => {}
        }
    }
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

#[cfg(test)]
mod tests;
