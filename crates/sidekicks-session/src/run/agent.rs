//! Reads which agent a run is for, from the session's log: the agent its `agent.run.queued` names,
//! the one minted from a saved definition with it, else the session's lead, for a lead run queued
//! before a run named its agent; the binding that agent runs on now, from its `agents` row; the
//! account that event admitted the run against; the session's lead, which `session.created` names, with the binding
//! and the model it runs on now; and whether the log names an agent at all.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::ModelRerouteScope;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::IdError;
use sidekicks_provider::runtime_binding::store::RuntimeBinding;
use sidekicks_provider::runtime_binding::store::read_newest_resumable_binding_of_runs;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{StoredJsonFault, text_column};
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, readable_event_sql, session_read_bound,
};

use crate::run::ids::read_session_run_ids;

use crate::agents::projection::read_agent_row;

static SELECT_RUN_AGENT_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    let run_queued = SessionEventType::AgentRunQueued.as_str();
    format!(
        "SELECT COALESCE(
      json_extract(queued.payload, '$.agentId'),
      json_extract(queued.payload, '$.resolvedAgent.agentId'),
      (SELECT json_extract(created.payload, '$.mainAgent.agentId')
         FROM session_events AS created
        WHERE created.session_id = queued.session_id
          AND created.type = '{session_created}')) AS agent_id
   FROM session_events AS queued
  WHERE queued.session_id = @session_id
    AND queued.type = '{run_queued}'
    AND queued.run_id = @run_id"
    )
});

static SELECT_RUN_ACCOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    let run_queued = SessionEventType::AgentRunQueued.as_str();
    format!(
        "SELECT json_extract(payload, '$.admittedProviderAccountId')
   FROM session_events
  WHERE session_id = @session_id AND type = '{run_queued}' AND run_id = @run_id"
    )
});

static SELECT_LEAD_AGENT_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    format!(
        "
  SELECT json_extract(payload, '$.mainAgent.agentId') AS agent_id
   FROM session_events
  WHERE session_id = ? AND type = '{session_created}'"
    )
});

// The bindings the agent of the CTE `born` (its `sequence`, `agent_id`, `binding` and `model`)
// took, as the CTE `bindings` of its `sequence`, `binding` and `model`: its birth's, then each of
// its landed switches in the session's readable log, each switch's `to` with the account it pins,
// never the one it landed on, so an agent that follows the current account still follows it.
fn agent_bindings_cte(born: &str) -> String {
    let binding_changed = SessionEventType::AgentProviderBindingChanged.as_str();
    let readable_changed = readable_event_sql("changed");
    format!(
        "bindings AS (
    SELECT sequence, binding, model FROM {born}
    UNION ALL
    SELECT changed.sequence,
           json_extract(changed.payload, '$.to'),
           json_extract(changed.payload, '$.to.modelId')
      FROM session_events AS changed JOIN {born}
     WHERE changed.session_id = @session_id AND changed.type = '{binding_changed}'
       AND json_extract(changed.payload, '$.agentId') = {born}.agent_id
       AND {readable_changed})"
    )
}

// The lead as the session's readable log leaves it: its agent, which `session.created` names; its
// binding, from the newest of that event and the lead's landed switches, each switch's `to` with
// the account it pins, never the one it landed on, so a lead that follows the current account
// still follows it; and the model it runs on, from the newest of those and the provider's moves
// of the rest of the session onto another model, of the lead's turns or of no agent's. A row
// before the session's creation sorts behind its own, so it moves nothing.
static SELECT_SESSION_LEAD_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    let turn_rerouted = SessionEventType::AgentTurnRerouted.as_str();
    let session_scope =
        serde_json::to_value(ModelRerouteScope::Session).expect("a closed word serializes");
    let session_scope = session_scope
        .as_str()
        .expect("a closed word serializes as text");
    let readable_born = readable_event_sql("born");
    let readable_rerouted = readable_event_sql("rerouted");
    let bindings = agent_bindings_cte("lead");
    format!(
        "WITH lead AS (
    SELECT born.sequence AS sequence,
           json_extract(born.payload, '$.mainAgent.agentId') AS agent_id,
           json_extract(born.payload, '$.mainAgent.binding') AS binding,
           json_extract(born.payload, '$.mainAgent.binding.modelId') AS model
      FROM session_events AS born
     WHERE born.session_id = @session_id AND born.type = '{session_created}'
       AND {readable_born}),
  {bindings},
  models AS (
    SELECT sequence, model FROM bindings
    UNION ALL
    SELECT rerouted.sequence, json_extract(rerouted.payload, '$.toModel')
      FROM session_events AS rerouted JOIN lead
     WHERE rerouted.session_id = @session_id AND rerouted.type = '{turn_rerouted}'
       AND json_extract(rerouted.payload, '$.scope') = '{session_scope}'
       AND (json_extract(rerouted.payload, '$.agentId') IS NULL
            OR json_extract(rerouted.payload, '$.agentId') = lead.agent_id)
       AND {readable_rerouted})
SELECT lead.agent_id,
       (SELECT binding FROM bindings ORDER BY sequence DESC LIMIT 1),
       (SELECT model FROM models ORDER BY sequence DESC LIMIT 1)
  FROM lead"
    )
});

static SELECT_ACTIVE_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM sessions WHERE state = '{}' ORDER BY id",
        <&'static str>::from(SessionState::Active)
    )
});

// Whether the session's readable log names the agent: as its lead, or on a run queued for it.
static SELECT_AGENT_NAMED_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    let run_queued = SessionEventType::AgentRunQueued.as_str();
    let readable_created = readable_event_sql("created");
    let readable_queued = readable_event_sql("queued");
    format!(
        "SELECT EXISTS (
    SELECT 1 FROM session_events AS created
     WHERE created.session_id = @session_id AND created.type = '{session_created}'
       AND json_extract(created.payload, '$.mainAgent.agentId') = @agent_id
       AND {readable_created}
    UNION ALL
    SELECT 1 FROM session_events AS queued
     WHERE queued.session_id = @session_id AND queued.type = '{run_queued}'
       AND COALESCE(json_extract(queued.payload, '$.agentId'),
                    json_extract(queued.payload, '$.resolvedAgent.agentId')) = @agent_id
       AND {readable_queued})"
    )
});

/// A session's lead as its log leaves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLead {
    /// The lead's agent.
    pub agent_id: AgentId,
    /// The binding it runs on now; `provider_account_id` is the account it is pinned to, `None`
    /// for the provider's current account, which a run's admission resolves.
    pub binding: AgentProviderBinding,
    /// The model it runs on now: its binding's, or the one the provider moved the rest of the
    /// session onto since.
    pub running_model: ProviderToken,
}

/// The session's lead, read from the log's events before `read_bound` outside its skipped ranges;
/// `None` for a session whose readable log holds no `session.created`. Fails when SQLite refuses
/// the read or a stored id, binding or model does not read as its type.
pub fn read_session_lead(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
) -> rusqlite::Result<Option<SessionLead>> {
    reader
        .prepare_cached(&SELECT_SESSION_LEAD_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@read_bound": read_bound,
            },
            |row| {
                Ok(SessionLead {
                    agent_id: text_column(row, 0, |text| AgentId::new(&text))?,
                    binding: text_column(row, 1, |text| {
                        serde_json::from_str(&text).map_err(StoredJsonFault::from)
                    })?,
                    running_model: text_column(row, 2, ProviderToken::new)?,
                })
            },
        )
        .optional()
}

/// An active session whose lead follows a provider's current account: its lead as its log leaves
/// it, and the binding of its newest conversation, `None` for a session that has not run.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderSessionLead {
    /// The session.
    pub session_id: SessionId,
    /// Its lead.
    pub lead: SessionLead,
    /// The binding of its newest conversation, whose spawn account is the one it runs on.
    pub conversation: Option<RuntimeBinding>,
}

/// A session whose lead or newest conversation could not be read, which a read of every session
/// skips and names.
#[derive(Debug, thiserror::Error)]
#[error("the lead of session \"{session_id}\" could not be read")]
pub struct UnreadableSessionLead {
    /// The session.
    pub session_id: SessionId,
    /// Why its read failed.
    #[source]
    pub source: rusqlite::Error,
}

/// Every active session whose lead runs on `provider` and follows its current account, pinned to
/// none, in id order, each lead read from its log outside the skipped ranges
/// `read_damaged_from_sequence` answers; a session whose stored id, binding or model does not
/// read stands as an [`UnreadableSessionLead`] in its place, so the rest still read. Fails as
/// SQLite fails to list the sessions.
pub fn read_provider_session_leads(
    reader: &Connection,
    provider: &ProviderId,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
) -> rusqlite::Result<Vec<Result<ProviderSessionLead, UnreadableSessionLead>>> {
    let session_ids = reader
        .prepare_cached(&SELECT_ACTIVE_SESSIONS_SQL)?
        .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut leads = Vec::new();
    for session_id in session_ids {
        match read_following_lead(reader, session_id, provider, read_damaged_from_sequence) {
            Ok(Some(lead)) => leads.push(Ok(lead)),
            Ok(None) => {}
            Err(source) => leads.push(Err(UnreadableSessionLead { session_id, source })),
        }
    }
    Ok(leads)
}

// `session_id`'s lead with its newest conversation where it runs on `provider` and follows its
// current account; `None` where it does not, or its log names no lead.
fn read_following_lead(
    reader: &Connection,
    session_id: SessionId,
    provider: &ProviderId,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
) -> rusqlite::Result<Option<ProviderSessionLead>> {
    let read_bound = session_read_bound(read_damaged_from_sequence, &session_id, None);
    let Some(lead) = read_session_lead(reader, &session_id, read_bound)? else {
        return Ok(None);
    };
    if lead.binding.provider_name != *provider || lead.binding.provider_account_id.is_some() {
        return Ok(None);
    }
    let conversation =
        read_newest_resumable_binding_of_runs(reader, &read_session_run_ids(reader, &session_id)?)?;
    Ok(Some(ProviderSessionLead {
        session_id,
        lead,
        conversation,
    }))
}

/// Whether the session's log names `agent_id`, as its lead or on a run queued for it, in its
/// events before `read_bound` outside its skipped ranges. Fails when SQLite refuses the read.
pub(crate) fn is_agent_named(
    reader: &Connection,
    session_id: &SessionId,
    agent_id: &AgentId,
    read_bound: i64,
) -> rusqlite::Result<bool> {
    reader.prepare_cached(&SELECT_AGENT_NAMED_SQL)?.query_row(
        named_params! {
            "@session_id": session_id.text().as_str(),
            "@agent_id": agent_id.text().as_str(),
            "@read_bound": read_bound,
        },
        |row| row.get(0),
    )
}

/// The statements [`RunAgentReader`] runs: the run's agent, its row, its admitted account and the
/// session's lead.
pub const RUN_AGENT_STATEMENT_CAPACITY: usize = 4;

/// The agent a run is for and the binding it runs on now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunAgent {
    /// The agent.
    pub agent_id: AgentId,
    /// Its binding, effort, options and speed included; `provider_account_id` is the account the
    /// binding pins, `None` for the provider's current account.
    pub binding: AgentProviderBinding,
}

/// Why the agent of a run, or a session's lead, could not be read.
#[derive(Debug, thiserror::Error)]
pub enum RunAgentReadError {
    /// The log holds no `session.created` naming the session's lead.
    #[error("session \"{session_id}\" has no lead its log names")]
    NoLeadAgent {
        /// The session read.
        session_id: SessionId,
    },
    /// The log names no agent for the run: every run is queued with its agent, or is the lead's
    /// run of a session born with its lead, so this is a broken log.
    #[error(
        "run \"{}\" of session \"{}\" has no agent its log names",
        .run_id,
        .session_id
    )]
    NoRunAgent {
        /// The session read.
        session_id: SessionId,
        /// The run read.
        run_id: RunId,
    },
    /// The log names no account for the run, or one by text that is no account id: every run is
    /// admitted against one, so this is a broken log.
    #[error(
        "run \"{}\" of session \"{}\" has no account its log names",
        .run_id,
        .session_id
    )]
    NoRunAccount {
        /// The session read.
        session_id: SessionId,
        /// The run read.
        run_id: RunId,
    },
    /// The agent the log names for a run has no `agents` row: each agent's row is written in the
    /// append of the event that brings it in, so this is a broken store.
    #[error(
        "agent \"{}\" of session \"{}\" has no row",
        .agent_id,
        .session_id
    )]
    NoAgentBinding {
        /// The session read.
        session_id: SessionId,
        /// The agent read.
        agent_id: AgentId,
    },
    /// The log names an agent by text that is no agent id.
    #[error("the session's log names an agent by text that is no agent id")]
    MalformedAgentId(#[source] IdError),
    /// The read itself failed.
    #[error("reading the session's log for an agent failed")]
    Read(#[from] rusqlite::Error),
}

/// The session's lead agent, read through `pool`. Fails as `RunAgentReader::read_lead_agent`
/// does, and as the pool does.
pub async fn read_lead_agent_through<Failure>(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<AgentId, Failure>
where
    Failure: From<DatabaseReadError> + From<RunAgentReadError> + Send + 'static,
{
    pool.read(ReadLength::Short, move |reader| -> Result<_, Failure> {
        Ok(RunAgentReader::new(reader).read_lead_agent(&session_id)?)
    })
    .await
}

/// Reads the agent of a run, the binding it runs on, and a session's lead, on the reader the
/// caller passes.
pub struct RunAgentReader<'connection> {
    /// The daemon's read-only connection.
    reader: &'connection Connection,
}

impl<'connection> RunAgentReader<'connection> {
    /// A reader over `reader`, the daemon's read-only connection.
    pub fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The session's lead agent. Fails with [`RunAgentReadError::NoLeadAgent`] when the log holds
    /// no `session.created` naming one.
    pub(crate) fn read_lead_agent(
        &self,
        session_id: &SessionId,
    ) -> Result<AgentId, RunAgentReadError> {
        let agent_id: Option<String> = self
            .reader
            .prepare_cached(&SELECT_LEAD_AGENT_SQL)?
            .query_row([session_id.text().as_str()], |row| row.get(0))
            .optional()?
            .flatten();
        let agent_id = agent_id.ok_or_else(|| RunAgentReadError::NoLeadAgent {
            session_id: *session_id,
        })?;
        AgentId::new(&agent_id).map_err(RunAgentReadError::MalformedAgentId)
    }

    /// The agent the run is for. Fails with [`RunAgentReadError::NoRunAgent`] when the log names
    /// none.
    pub fn read_agent(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
    ) -> Result<AgentId, RunAgentReadError> {
        let agent_id: Option<String> = self
            .reader
            .prepare_cached(&SELECT_RUN_AGENT_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@run_id": run_id.text().as_str(),
                },
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let agent_id = agent_id.ok_or_else(|| RunAgentReadError::NoRunAgent {
            session_id: *session_id,
            run_id: *run_id,
        })?;
        AgentId::new(&agent_id).map_err(RunAgentReadError::MalformedAgentId)
    }

    /// The agent the run is for and the binding its `agents` row holds now. Fails as
    /// [`Self::read_agent`] does, and with [`RunAgentReadError::NoAgentBinding`] when the agent has
    /// no row.
    pub fn read_agent_binding(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
    ) -> Result<RunAgent, RunAgentReadError> {
        let agent_id = self.read_agent(session_id, run_id)?;
        let row =
            read_agent_row(self.reader, &agent_id)?.ok_or(RunAgentReadError::NoAgentBinding {
                session_id: *session_id,
                agent_id,
            })?;
        Ok(RunAgent {
            agent_id,
            binding: row.binding,
        })
    }

    /// The account the run was admitted against, as its `agent.run.queued` names it. Fails with
    /// [`RunAgentReadError::NoRunAccount`] when the log names none.
    pub fn read_admitted_account(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
    ) -> Result<ProviderAccountId, RunAgentReadError> {
        let account_id: Option<String> = self
            .reader
            .prepare_cached(&SELECT_RUN_ACCOUNT_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@run_id": run_id.text().as_str(),
                },
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        account_id
            .and_then(ProviderAccountId::new)
            .ok_or(RunAgentReadError::NoRunAccount {
                session_id: *session_id,
                run_id: *run_id,
            })
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_run_id, test_session_id,
    };
    use sidekicks_store::events::session::read::session_read_bound;

    use super::{RunAgent, RunAgentReader, SessionLead, read_session_lead};
    use crate::agents::projection::test_fixture::{binding, project, session_created};
    use crate::agents::schema::schema_parts;

    // One session's log, written row by row in sequence order.
    struct Log {
        _database: TestDatabase,
        connection: Connection,
        session_id: SessionId,
        sequence: i64,
    }

    impl Log {
        fn new() -> Self {
            let database = TestDatabase::new(schema_parts());
            let connection = database.opener()().expect("the test creates its database");
            Self {
                _database: database,
                connection,
                session_id: test_session_id(),
                sequence: 0,
            }
        }

        fn write(&mut self, event_type: SessionEventType, payload: &Value) {
            self.write_of_run(event_type, payload, None);
        }

        fn write_of_run(
            &mut self,
            event_type: SessionEventType,
            payload: &Value,
            run_id: Option<&RunId>,
        ) {
            self.connection
                .execute(
                    "INSERT INTO session_events
                       (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
                        payload, run_id)
                     VALUES (?1, ?2, ?3, '2026-10-28T09:00:00.000Z', ?3, ?4, ?5, ?6, ?7)",
                    params![
                        mint_uuid_v7().to_string(),
                        self.session_id.text().as_str(),
                        self.sequence,
                        event_type.category().as_str(),
                        event_type.as_str(),
                        payload.to_string(),
                        run_id.map(|run_id| run_id.text().as_str().to_owned()),
                    ],
                )
                .expect("the test writes the row");
            self.sequence += 1;
        }

        // Queues a run for `agent_id`, naming it by id.
        fn queue_run(&mut self, agent_id: &str) -> RunId {
            let run_id = test_run_id();
            self.write_of_run(
                SessionEventType::AgentRunQueued,
                &json!({ "agentId": agent_id }),
                Some(&run_id),
            );
            run_id
        }

        fn run_agent(&self, run_id: &RunId) -> RunAgent {
            RunAgentReader::new(&self.connection)
                .read_agent_binding(&self.session_id, run_id)
                .expect("the run's agent reads")
        }

        fn switch(&mut self, agent_id: &str, to: &Value, landed: &str) {
            self.write(
                SessionEventType::AgentProviderBindingChanged,
                &json!({
                    "agentId": agent_id,
                    "to": to,
                    "landedProviderAccountId": landed,
                }),
            );
        }

        fn reroute(&mut self, agent_id: Option<&str>, scope: &str, model: &str) {
            let mut payload = json!({ "toModel": model, "scope": scope });
            if let Some(agent_id) = agent_id {
                payload["agentId"] = json!(agent_id);
            }
            self.write(SessionEventType::AgentTurnRerouted, &payload);
        }

        fn lead(&self) -> SessionLead {
            let read_bound = session_read_bound(|_| None, &self.session_id, None);
            read_session_lead(&self.connection, &self.session_id, read_bound)
                .expect("the lead reads")
                .expect("the session has a lead")
        }
    }

    fn pinned_binding(provider: &str, model: &str, account: &str) -> Value {
        let mut binding = binding(provider, model);
        binding["providerAccountId"] = json!(account);
        binding
    }

    // Read after each row: (provider, account, running model).
    fn standing(lead: &SessionLead) -> (String, Option<String>, String) {
        (
            lead.binding.provider_name.as_str().to_owned(),
            lead.binding
                .provider_account_id
                .as_ref()
                .map(|account| account.as_str().to_owned()),
            lead.running_model.as_str().to_owned(),
        )
    }

    // Killed by the agent check dropped from the switch or the reroute, by the scope check dropped,
    // by the account a switch landed on read as the account it pins, and by the running model read
    // from the binding alone.
    #[test]
    fn the_lead_moves_with_its_own_switches_and_session_long_reroutes_only() {
        let (first, second) = (PROVIDERS[0].id, PROVIDERS[1].id);
        let lead = mint_uuid_v7().to_string();
        let other = mint_uuid_v7().to_string();
        let mut log = Log::new();
        log.write(
            SessionEventType::SessionCreated,
            &json!({ "mainAgent": { "agentId": lead, "binding": binding(first, "model-a") } }),
        );
        assert_eq!(log.lead().agent_id.text().as_str(), lead);
        let born = (first.to_owned(), None, "model-a".to_owned());
        assert_eq!(standing(&log.lead()), born);

        log.switch(&other, &binding(second, "model-x"), "account-x");
        log.reroute(Some(&other), "session", "model-x");
        assert_eq!(standing(&log.lead()), born, "another agent's moves");

        log.switch(&lead, &binding(second, "model-b"), "account-1");
        let switched = (second.to_owned(), None, "model-b".to_owned());
        assert_eq!(standing(&log.lead()), switched, "a follower stays one");

        log.reroute(None, "session", "model-c");
        let rerouted = (second.to_owned(), None, "model-c".to_owned());
        assert_eq!(standing(&log.lead()), rerouted, "a session-long move");

        log.reroute(Some(&lead), "turn", "model-d");
        log.reroute(Some(&lead), "local", "model-d");
        assert_eq!(
            standing(&log.lead()),
            rerouted,
            "a turn's or a helper's move"
        );

        log.reroute(Some(&lead), "session", "model-e");
        log.switch(
            &lead,
            &pinned_binding(first, "model-f", "account-p"),
            "account-2",
        );
        assert_eq!(
            standing(&log.lead()),
            (
                first.to_owned(),
                Some("account-p".to_owned()),
                "model-f".to_owned()
            ),
            "the newer switch's model and pin win"
        );
    }

    // Killed by the binding read from anywhere but the agent's row, the row's own model then never
    // answered, and by the run's agent read as another's.
    #[test]
    fn a_runs_agent_runs_on_its_rows_binding() {
        let lead = mint_uuid_v7().to_string();
        let mut log = Log::new();
        let created = session_created(log.session_id, &lead, &binding(PROVIDERS[0].id, "model-a"));
        project(&log.connection, log.session_id, &created);
        let run_id = log.queue_run(&lead);
        log.connection
            .execute(
                "UPDATE agents SET model_id = 'model-row' WHERE id = ?1",
                [&lead],
            )
            .expect("the test moves the row");

        let agent = log.run_agent(&run_id);
        assert_eq!(agent.agent_id.text().as_str(), lead);
        assert_eq!(agent.binding.model_id.as_str(), "model-row");
    }
}
