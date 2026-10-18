//! Reads a run's current state and version from its `runs` row, the runs not yet ended, the live
//! provider subagents beneath one run, and the provider a run runs on, from its runtime binding or
//! the binding of the parent whose provider process it runs in.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
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

// Walks up from the run through each provider subagent to the parent whose process it runs in, and
// takes the nearest run with a binding; a run's bindings all name the provider its first spawn
// bound, so that run's newest one answers.
const SELECT_RUN_PROVIDER_SQL: &str = "WITH RECURSIVE lineage(run_id, depth) AS (
    SELECT @run_id, 0
    UNION ALL
    SELECT runs.parent_run_id, lineage.depth + 1
      FROM runs JOIN lineage ON runs.run_id = lineage.run_id
      WHERE runs.reached_by = 'providerSubagent'
  )
  SELECT runtime_bindings.provider_name
  FROM lineage JOIN runtime_bindings ON runtime_bindings.run_id = lineage.run_id
  ORDER BY lineage.depth, runtime_bindings.created_at DESC, runtime_bindings.id DESC
  LIMIT 1";

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
    #[expect(dead_code, reason = "the daemon's recovery pass at start")]
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

/// The run's current state and version read through `pool`, or `None` for a run the daemon has
/// no row for. Fails as the pool and the read do.
pub(crate) async fn read_run_through<Failure>(
    pool: &DatabaseReadPool,
    run_id: RunId,
) -> Result<Option<RunRead>, Failure>
where
    Failure: From<DatabaseReadError> + From<rusqlite::Error> + Send + 'static,
{
    pool.read(ReadLength::Short, move |reader| -> Result<_, Failure> {
        Ok(RunStateReader::new(reader).read_run(&run_id)?)
    })
    .await
}

/// The provider `run_id` runs on, read on `reader`: the one its newest runtime binding names, or,
/// for a provider subagent, the nearest parent's whose provider process it runs in; `None` when
/// none of them has a binding. Fails when SQLite refuses the read or the stored name is no
/// provider id.
pub(crate) fn read_run_provider(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<ProviderId>> {
    reader
        .prepare_cached(SELECT_RUN_PROVIDER_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            text_column(row, 0, closed_word::<ProviderId>)
        })
        .optional()
}

/// A stored run version as the wire carries it.
pub(crate) fn safe_run_version(version: i64) -> SafeInt<0> {
    u64::try_from(version)
        .ok()
        .and_then(SafeInt::new)
        .expect("a run's version counts up from zero within the safe integers")
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use sidekicks_contracts::run::id::RunId;

    use super::read_run_provider;
    use crate::database::writer::test_file::test_session_id;
    use crate::provider::driver::registry::test_provider;
    use crate::session::run::projection::RUNS_TABLE_SQL;
    use crate::uuid_v7::mint_uuid_v7;

    // The runtime bindings table as the daemon's schema declares it, its checks left out.
    const RUNTIME_BINDINGS_TABLE_SQL: &str = "
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  provider_name       TEXT NOT NULL,
  contract_version    TEXT NOT NULL,
  cli_version_raw     TEXT NOT NULL,
  cli_version_semver  TEXT,
  resume_handle       TEXT,
  spawn_config        TEXT NOT NULL DEFAULT '{}',
  runtime_metadata    TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;
";

    // Killed by reading the run's own binding alone, which finds none for a subagent, by climbing
    // only one level, or by climbing from a child reached any other way, which runs on a provider
    // process of its own.
    #[test]
    fn a_provider_subagent_runs_on_the_provider_of_the_nearest_parent_with_a_binding() {
        let connection = Connection::open_in_memory().expect("the test opens a database");
        connection
            .execute_batch(RUNS_TABLE_SQL)
            .and_then(|()| connection.execute_batch(RUNTIME_BINDINGS_TABLE_SQL))
            .expect("the test makes its tables");
        let session_id = test_session_id();
        let new_run = |parent: Option<&RunId>, reached_by: Option<&str>| {
            let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
            connection
                .execute(
                    "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state,
                       run_version)
                     VALUES (?1, ?2, ?3, ?4, 'running', 1)",
                    params![
                        run_id.text().as_str(),
                        session_id.text().as_str(),
                        parent.map(|parent| parent.text().as_str().to_owned()),
                        reached_by
                    ],
                )
                .expect("the test writes the run");
            run_id
        };
        let lead = new_run(None, None);
        connection
            .execute(
                "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
                   cli_version_raw, created_at, updated_at)
                 VALUES ('binding', ?1, ?2, '1.0.0', '1.0.0', '', '')",
                params![lead.text().as_str(), test_provider().as_str()],
            )
            .expect("the test binds the lead run");
        let subagent = new_run(Some(&lead), Some("providerSubagent"));
        let nested_subagent = new_run(Some(&subagent), Some("providerSubagent"));
        let bridge_run = new_run(Some(&lead), Some("bridgeRun"));

        assert_eq!(
            read_run_provider(&connection, &nested_subagent).expect("the read runs"),
            Some(test_provider())
        );
        assert_eq!(
            read_run_provider(&connection, &bridge_run).expect("the read runs"),
            None
        );
    }
}
