//! Reads a run's current state and version from its `runs` row, the runs not yet ended, and the
//! live provider subagents beneath one run.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::session::run::transitions::RUN_TERMINAL_STATES_SQL;

/// A run as it stands now. `version` counts every progression of the run, state changes and
/// applied interventions alike; a decision taken from it is guarded again inside the write it
/// decides, since another write may land between the read and that write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunRead {
    /// The run's version.
    pub(crate) version: i64,
    /// The session the run belongs to.
    pub(crate) session_id: SessionId,
    /// The run's current state.
    pub(crate) state: RunState,
}

/// A run not yet ended, with the parent it was reached from and how; both absent on a lead run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveRun {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its state and version.
    pub(crate) run: RunRead,
    /// The run it was reached from; absent on a lead run.
    pub(crate) parent_run_id: Option<RunId>,
    /// How it was reached from its parent; absent on a lead run.
    pub(crate) reached_by: Option<ChildRunProvenance>,
}

const SELECT_RUN_SQL: &str = "SELECT session_id, state, run_version FROM runs WHERE run_id = ?";

// Walks down `idx_runs_parent` through live provider subagents only, so the read scales with the
// one run's tree and a subagent that has ended cuts its branch off.
static SELECT_LIVE_PROVIDER_SUBAGENTS_SQL: LazyLock<String> = LazyLock::new(|| {
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    format!(
        "WITH RECURSIVE subagents(run_id) AS (
    SELECT run_id FROM runs
      WHERE parent_run_id = @run_id AND reached_by = 'providerSubagent'
        AND state NOT IN ({terminal_states})
    UNION ALL
    SELECT runs.run_id FROM runs JOIN subagents ON runs.parent_run_id = subagents.run_id
      WHERE runs.reached_by = 'providerSubagent'
        AND runs.state NOT IN ({terminal_states})
  )
  SELECT run_id FROM subagents"
    )
});

// Spelled as the partial index on live runs spells it, so the scan reads that index.
static SELECT_LIVE_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id, session_id, state, run_version, parent_run_id, reached_by
  FROM runs
  WHERE state NOT IN ({})",
        *RUN_TERMINAL_STATES_SQL
    )
});

/// Reads runs on the daemon's read-only connection, which sees each write once it has committed.
/// A stored value that does not read as its type fails the read with
/// `rusqlite::Error::FromSqlConversionFailure`, keeping why.
pub(crate) struct RunStateReader<'connection> {
    /// The daemon's read-only connection.
    reader: &'connection Connection,
}

impl<'connection> RunStateReader<'connection> {
    /// A reader over `reader`, the daemon's read-only connection.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The run's current state and version, or `None` for a run the daemon has no row for.
    pub(crate) fn read_run(&self, run_id: &RunId) -> rusqlite::Result<Option<RunRead>> {
        self.reader
            .prepare_cached(SELECT_RUN_SQL)?
            .query_row([run_id.text().as_str()], |row| {
                Ok(RunRead {
                    session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                    state: text_column(row, 1, closed_word)?,
                    version: row.get(2)?,
                })
            })
            .optional()
    }

    /// Every run in every session that has not ended, queued runs included.
    pub(crate) fn list_live_runs(&self) -> rusqlite::Result<Vec<LiveRun>> {
        self.reader
            .prepare_cached(&SELECT_LIVE_RUNS_SQL)?
            .query_map([], |row| {
                Ok(LiveRun {
                    run_id: text_column(row, 0, |text| RunId::new(&text))?,
                    run: RunRead {
                        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                        state: text_column(row, 2, closed_word)?,
                        version: row.get(3)?,
                    },
                    parent_run_id: optional_text_column(row, 4, |text| RunId::new(&text))?,
                    reached_by: optional_text_column(row, 5, closed_word)?,
                })
            })?
            .collect()
    }

    /// The live runs `run_id`'s provider dispatched beneath it as its own subagents, at any depth
    /// through live ones; they share its process. A child reached any other way is not one.
    pub(crate) fn list_live_provider_subagents(
        &self,
        run_id: &RunId,
    ) -> rusqlite::Result<Vec<RunId>> {
        self.reader
            .prepare_cached(&SELECT_LIVE_PROVIDER_SUBAGENTS_SQL)?
            .query_map(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                text_column(row, 0, |text| RunId::new(&text))
            })?
            .collect()
    }
}
