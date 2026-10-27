//! Reads a run's current state and version from its `runs` row; the runs not yet ended across
//! every session or in one, and those of one session with the agent each runs for; the ended runs
//! that hold a turn with no end, across every session or in one; the provider subagents beneath
//! one run that are live or hold a turn with no end; and the provider a run runs on, from its
//! runtime binding or the binding of the parent whose provider process it runs in.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::{RUN_LIFECYCLE_EVENT_TYPES, SessionEventType};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::run::engine::turns::{open_turns_sql, turn_holds_no_end_sql};
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use sidekicks_provider::runtime_binding::store::StoredBindingIdInvalid;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::session_scope::SessionScopedSql;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::events::session::read::readable_event_sql;

/// A run as it stands now. `version` counts every progression of the run, state changes and
/// applied interventions alike; a decision taken from it is guarded again inside the write it
/// decides, since another write may land between the read and that write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRead {
    /// The run's version.
    pub version: i64,
    /// The session the run belongs to.
    pub session_id: SessionId,
    /// The run's current state.
    pub state: RunState,
}

/// A run and the session it belongs to, as a read across sessions names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionRun {
    /// The run.
    pub run_id: RunId,
    /// Its session.
    pub session_id: SessionId,
}

/// A row whose first column is a run's id and second its session's, as a [`SessionRun`]. Fails
/// when either does not read as its id.
pub fn session_run_of_row(row: &Row<'_>) -> rusqlite::Result<SessionRun> {
    Ok(SessionRun {
        run_id: text_column(row, 0, |text| RunId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
    })
}

/// A run not yet ended, with the parent it was reached from and how; both absent on a lead run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRun {
    /// The run.
    pub run_id: RunId,
    /// Its state and version.
    pub run: RunRead,
    /// The run it was reached from; absent on a lead run.
    pub(crate) parent_run_id: Option<RunId>,
    /// How it was reached from its parent; absent on a lead run.
    pub(crate) reached_by: Option<ChildRunProvenance>,
}

const SELECT_RUN_SQL: &str = "SELECT session_id, state, run_version FROM runs WHERE run_id = ?";

// Walks up from the run through each provider subagent to the parent whose process it runs in, and
// takes the nearest run with a binding; a run's bindings all name the provider its first spawn
// bound, so that run's newest one answers, with its id.
const SELECT_RUN_PROVIDER_SQL: &str = "WITH RECURSIVE lineage(run_id, depth) AS (
    SELECT @run_id, 0
    UNION ALL
    SELECT runs.parent_run_id, lineage.depth + 1
      FROM runs JOIN lineage ON runs.run_id = lineage.run_id
      WHERE runs.reached_by = 'providerSubagent'
  )
  SELECT runtime_bindings.id, runtime_bindings.provider_name
  FROM lineage JOIN runtime_bindings ON runtime_bindings.run_id = lineage.run_id
  ORDER BY lineage.depth, runtime_bindings.created_at DESC, runtime_bindings.id DESC
  LIMIT 1";

// Walks down `idx_runs_parent` through every provider subagent of the one run's tree, ended ones
// included, since a run beneath an ended one still runs in the same process; it keeps those live
// or holding a turn with no end.
static SELECT_UNSETTLED_PROVIDER_SUBAGENTS_SQL: LazyLock<String> = LazyLock::new(|| {
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    let provider_subagent = <&'static str>::from(ChildRunProvenance::ProviderSubagent);
    let open_turn = open_turns_sql("subagents.run_id", "LIMIT 1");
    format!(
        "WITH RECURSIVE subagents(run_id, state) AS (
    SELECT run_id, state FROM runs
      WHERE parent_run_id = @run_id AND reached_by = '{provider_subagent}'
    UNION ALL
    SELECT runs.run_id, runs.state FROM runs JOIN subagents ON runs.parent_run_id = subagents.run_id
      WHERE runs.reached_by = '{provider_subagent}'
  )
  SELECT run_id FROM subagents
  WHERE state NOT IN ({terminal_states}) OR EXISTS ({open_turn})"
    )
});

// Spelled as the partial index on live runs spells it, so the scan reads that index.
static SELECT_LIVE_RUNS_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    SessionScopedSql::new("session_id", |session_condition| {
        format!(
            "SELECT run_id, session_id, state, run_version, parent_run_id, reached_by
  FROM runs
  WHERE state NOT IN ({}) {session_condition}",
            *RUN_TERMINAL_STATES_SQL
        )
    })
});

// A run's agent is on its `agent.run.queued` row, by id or inside the agent it brought in. Its
// newest touch is its newest readable `runLifecycle` event. Both read the run-and-type index on the
// event log; the unary `+` drops the run id column's affinity, which would keep the index from
// serving.
static SELECT_SESSION_LIVE_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    let run_queued = SessionEventType::AgentRunQueued.as_str();
    let lifecycle_types = sql_list_of(
        RUN_LIFECYCLE_EVENT_TYPES
            .iter()
            .copied()
            .map(SessionEventType::as_str),
    );
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    let readable_queued = readable_event_sql("queued");
    let readable_lifecycle = readable_event_sql("lifecycle");
    format!(
        "SELECT run_id, parent_run_id, is_apart, state, run_version,
    (SELECT COALESCE(json_extract(queued.payload, '$.agentId'),
                     json_extract(queued.payload, '$.resolvedAgent.agentId'))
       FROM session_events AS queued
      WHERE queued.session_id = runs.session_id
        AND queued.type = '{run_queued}'
        AND queued.run_id = +runs.run_id
        AND {readable_queued}) AS agent_id,
    (SELECT touched.occurred_at
       FROM session_events AS touched
      WHERE touched.session_id = runs.session_id
        AND touched.sequence = (
          SELECT MAX(lifecycle.sequence)
            FROM session_events AS lifecycle
           WHERE lifecycle.session_id = runs.session_id
             AND lifecycle.type IN ({lifecycle_types})
             AND lifecycle.run_id = +runs.run_id
             AND {readable_lifecycle})) AS touched_at
  FROM runs
  WHERE session_id = @session_id
    AND state NOT IN ({terminal_states})
  ORDER BY rowid"
    )
});

// Every ended run that holds a started turn with no end, with its session, read through the turn
// starts' own run columns.
static SELECT_ENDED_RUNS_WITH_OPEN_TURNS_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    let category = EventCategory::RunLifecycle.as_str();
    SessionScopedSql::new("runs.session_id", |session_condition| {
        format!(
            "SELECT DISTINCT runs.run_id, runs.session_id
  FROM runs JOIN session_events AS started ON started.run_id = runs.run_id
  WHERE runs.state IN ({terminal_states})
    AND started.category = '{category}'
    AND started.type = '{started}'
    AND {no_end}
    {session_condition}",
            terminal_states = *RUN_TERMINAL_STATES_SQL,
            started = SessionEventType::AgentTurnStarted.as_str(),
            no_end = turn_holds_no_end_sql(),
        )
    })
});

/// Reads runs on the daemon's read-only connection, which sees each write once it has committed.
/// A stored value that does not read as its type fails the read with
/// `rusqlite::Error::FromSqlConversionFailure`, keeping why.
pub struct RunStateReader<'connection> {
    /// The daemon's read-only connection.
    reader: &'connection Connection,
}

impl<'connection> RunStateReader<'connection> {
    /// A reader over `reader`, the daemon's read-only connection.
    pub fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The run's current state and version, or `None` for a run the daemon has no row for.
    pub fn read_run(&self, run_id: &RunId) -> rusqlite::Result<Option<RunRead>> {
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

    /// Every run of `session_id`, or of every session when it is `None`, that has not ended,
    /// queued runs included.
    pub fn list_live_runs(&self, session_id: Option<&SessionId>) -> rusqlite::Result<Vec<LiveRun>> {
        SELECT_LIVE_RUNS_SQL.query(self.reader, session_id, |row| {
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
        })
    }

    /// Every run of `session_id`, or of every session when it is `None`, that has ended while a
    /// turn of it holds no end, as a restart finds it.
    pub fn list_ended_runs_with_open_turns(
        &self,
        session_id: Option<&SessionId>,
    ) -> rusqlite::Result<Vec<SessionRun>> {
        SELECT_ENDED_RUNS_WITH_OPEN_TURNS_SQL.query(self.reader, session_id, session_run_of_row)
    }

    /// The runs `run_id`'s provider dispatched beneath it as its own subagents, at any depth, that
    /// are live or hold a turn with no end; they share its process. A child reached any other way
    /// is not one.
    pub(crate) fn list_unsettled_provider_subagents(
        &self,
        run_id: &RunId,
    ) -> rusqlite::Result<Vec<RunId>> {
        self.reader
            .prepare_cached(&SELECT_UNSETTLED_PROVIDER_SUBAGENTS_SQL)?
            .query_map(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                text_column(row, 0, |text| RunId::new(&text))
            })?
            .collect()
    }
}

/// The run's current state and version read through `pool`, or `None` for a run the daemon has
/// no row for. Fails as the pool and the read do.
pub async fn read_run_through<Failure>(
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

/// The runtime binding a run runs under and the provider it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunProvider {
    /// The binding.
    pub binding_id: RuntimeBindingId,
    /// The provider the binding runs on.
    pub provider: ProviderId,
}

/// The provider `run_id` runs on, read on `reader`, with the binding that names it: its own newest
/// runtime binding, or, for a provider subagent, the nearest parent's whose provider process it
/// runs in; `None` when none of them has a binding. Fails when SQLite refuses the read or a stored
/// id or name does not read as its type.
pub fn read_run_provider(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<RunProvider>> {
    reader
        .prepare_cached(SELECT_RUN_PROVIDER_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            Ok(RunProvider {
                binding_id: text_column(row, 0, |text| {
                    RuntimeBindingId::new(text).ok_or(StoredBindingIdInvalid)
                })?,
                provider: text_column(row, 1, closed_word::<ProviderId>)?,
            })
        })
        .optional()
}

/// One live run of a session as its `runs` row and its log answer it: who it was reached from,
/// whether it runs apart, its state and version, its agent and its newest touch; the agent and the
/// touch are `None` when its `agent.run.queued` is past the read bound or skipped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionLiveRunRow {
    /// The run.
    pub(crate) run_id: RunId,
    /// The run it was reached from; absent on a lead run.
    pub(crate) parent_run_id: Option<RunId>,
    /// Whether it runs apart from its parent.
    pub(crate) is_apart: bool,
    /// Its state.
    pub(crate) state: RunState,
    /// Its version.
    pub(crate) run_version: SafeInt<0>,
    /// The agent its `agent.run.queued` names.
    pub(crate) agent_id: Option<AgentId>,
    /// When its newest readable lifecycle event happened.
    pub(crate) touched_at: Option<WireInstant>,
}

/// The live runs of `session_id` in the order they were written, read on `reader` with the log
/// read before `read_bound`. Fails when SQLite refuses the read or a stored column does not read
/// as its type.
pub(crate) fn read_session_live_runs(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
) -> rusqlite::Result<Vec<SessionLiveRunRow>> {
    reader
        .prepare_cached(&SELECT_SESSION_LIVE_RUNS_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@read_bound": read_bound,
            },
            |row| {
                Ok(SessionLiveRunRow {
                    run_id: text_column(row, 0, |text| RunId::new(&text))?,
                    parent_run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
                    is_apart: row.get(2)?,
                    state: text_column(row, 3, closed_word)?,
                    run_version: safe_int_column(row, 4)?,
                    agent_id: optional_text_column(row, 5, |text| AgentId::new(&text))?,
                    touched_at: optional_text_column(row, 6, WireInstant::try_from)?,
                })
            },
        )?
        .collect()
}

/// A stored run version as the wire carries it.
pub fn safe_run_version(version: i64) -> SafeInt<0> {
    u64::try_from(version)
        .ok()
        .and_then(SafeInt::new)
        .expect("a run's version counts up from zero within the safe integers")
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use sidekicks_contracts::run::id::RunId;

    use super::read_run_provider;
    use crate::questions::schema::schema_parts;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};

    // Killed by reading the run's own binding alone, which finds none for a subagent, by climbing
    // only one level, or by climbing from a child reached any other way, which runs on a provider
    // process of its own.
    #[test]
    fn a_provider_subagent_runs_on_the_provider_of_the_nearest_parent_with_a_binding() {
        let database = TestDatabase::new(schema_parts());
        let connection = database.opener()().expect("the test creates its database");
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
        bind_run_to_first_provider(&database, lead);
        let subagent = new_run(Some(&lead), Some("providerSubagent"));
        let nested_subagent = new_run(Some(&subagent), Some("providerSubagent"));
        let bridge_run = new_run(Some(&lead), Some("bridgeRun"));

        assert_eq!(
            read_run_provider(&connection, &nested_subagent)
                .expect("the read runs")
                .map(|bound| bound.provider.as_str().to_owned())
                .as_deref(),
            Some(PROVIDERS[0].id)
        );
        assert_eq!(
            read_run_provider(&connection, &bridge_run).expect("the read runs"),
            None
        );
    }
}
