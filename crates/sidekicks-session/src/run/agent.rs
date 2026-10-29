//! Reads which agent a run is for, from the session's log: the agent its `agent.run.queued` names,
//! the one minted from a saved definition with it, else the session's lead, for a lead run queued
//! before a run named its agent; the account that event admitted the run against; the session's
//! lead, which `session.created` names, with the binding and the model it runs on now; and
//! whether the log names an agent at all.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::ModelRerouteScope;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::IdError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{StoredJsonFault, text_column};
use sidekicks_store::events::session::read::readable_event_sql;

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

// The lead as the session's readable log leaves it: its agent, which `session.created` names; its
// binding, from the newest of that event and the lead's landed switches, a switch's account the one
// it landed on, since its `to` may follow the provider's current account; and the model it runs
// on, from the newest of those and the provider's moves of the rest of the session onto another
// model, of the lead's turns or of no agent's. A row before the session's creation sorts behind
// its own, so it moves nothing.
static SELECT_SESSION_LEAD_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    let binding_changed = SessionEventType::AgentProviderBindingChanged.as_str();
    let turn_rerouted = SessionEventType::AgentTurnRerouted.as_str();
    let session_scope =
        serde_json::to_value(ModelRerouteScope::Session).expect("a closed word serializes");
    let session_scope = session_scope
        .as_str()
        .expect("a closed word serializes as text");
    let readable_born = readable_event_sql("born");
    let readable_changed = readable_event_sql("changed");
    let readable_rerouted = readable_event_sql("rerouted");
    format!(
        "WITH lead AS (
    SELECT born.sequence AS sequence,
           json_extract(born.payload, '$.mainAgent.agentId') AS agent_id,
           json_extract(born.payload, '$.mainAgent.binding') AS binding,
           json_extract(born.payload, '$.mainAgent.binding.modelId') AS model
      FROM session_events AS born
     WHERE born.session_id = @session_id AND born.type = '{session_created}'
       AND {readable_born}),
  bindings AS (
    SELECT sequence, binding, model FROM lead
    UNION ALL
    SELECT changed.sequence,
           json_set(json_extract(changed.payload, '$.to'), '$.providerAccountId',
                    json_extract(changed.payload, '$.landedProviderAccountId')),
           json_extract(changed.payload, '$.to.modelId')
      FROM session_events AS changed JOIN lead
     WHERE changed.session_id = @session_id AND changed.type = '{binding_changed}'
       AND json_extract(changed.payload, '$.agentId') = lead.agent_id
       AND {readable_changed}),
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
    /// The binding it runs on now; `provider_account_id` is the account its last switch landed
    /// on, `None` for the provider's current account, which a run's admission resolves.
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

/// The statements [`RunAgentReader`] runs: the run's agent, its admitted account and the session's
/// lead.
pub const RUN_AGENT_STATEMENT_CAPACITY: usize = 3;

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

/// Reads the agent of a run, and a session's lead, from the session's log on the reader the
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
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::session::read::session_read_bound;

    use super::{SessionLead, read_session_lead};
    use crate::run::schema::schema_parts;

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

        fn write(&mut self, event_type: SessionEventType, payload: Value) {
            self.connection
                .execute(
                    "INSERT INTO session_events
                       (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
                        payload)
                     VALUES (?1, ?2, ?3, '2026-10-28T09:00:00.000Z', ?3, ?4, ?5, ?6)",
                    params![
                        mint_uuid_v7().to_string(),
                        self.session_id.text().as_str(),
                        self.sequence,
                        event_type.category().as_str(),
                        event_type.as_str(),
                        payload.to_string(),
                    ],
                )
                .expect("the test writes the row");
            self.sequence += 1;
        }

        fn switch(&mut self, agent_id: &str, provider: &str, model: &str, landed: &str) {
            self.write(
                SessionEventType::AgentProviderBindingChanged,
                json!({
                    "agentId": agent_id,
                    "to": binding(provider, model),
                    "landedProviderAccountId": landed,
                }),
            );
        }

        fn reroute(&mut self, agent_id: Option<&str>, scope: &str, model: &str) {
            let mut payload = json!({ "toModel": model, "scope": scope });
            if let Some(agent_id) = agent_id {
                payload["agentId"] = json!(agent_id);
            }
            self.write(SessionEventType::AgentTurnRerouted, payload);
        }

        fn lead(&self) -> SessionLead {
            let read_bound = session_read_bound(|_| None, &self.session_id, None);
            read_session_lead(&self.connection, &self.session_id, read_bound)
                .expect("the lead reads")
                .expect("the session has a lead")
        }
    }

    fn binding(provider: &str, model: &str) -> Value {
        json!({
            "providerName": provider,
            "modelId": model,
            "effort": null,
            "providerAccountId": null,
        })
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
    // by a switch's own `to` account kept over the one it landed on, and by the running model read
    // from the binding alone.
    #[test]
    fn the_lead_moves_with_its_own_switches_and_session_long_reroutes_only() {
        let (first, second) = (PROVIDERS[0].id, PROVIDERS[1].id);
        let lead = mint_uuid_v7().to_string();
        let other = mint_uuid_v7().to_string();
        let mut log = Log::new();
        log.write(
            SessionEventType::SessionCreated,
            json!({ "mainAgent": { "agentId": lead, "binding": binding(first, "model-a") } }),
        );
        assert_eq!(log.lead().agent_id.text().as_str(), lead);
        let born = (first.to_owned(), None, "model-a".to_owned());
        assert_eq!(standing(&log.lead()), born);

        log.switch(&other, second, "model-x", "account-x");
        log.reroute(Some(&other), "session", "model-x");
        assert_eq!(standing(&log.lead()), born, "another agent's moves");

        log.switch(&lead, second, "model-b", "account-1");
        let switched = (
            second.to_owned(),
            Some("account-1".to_owned()),
            "model-b".to_owned(),
        );
        assert_eq!(standing(&log.lead()), switched);

        log.reroute(None, "session", "model-c");
        let rerouted = (
            second.to_owned(),
            Some("account-1".to_owned()),
            "model-c".to_owned(),
        );
        assert_eq!(standing(&log.lead()), rerouted, "a session-long move");

        log.reroute(Some(&lead), "turn", "model-d");
        log.reroute(Some(&lead), "local", "model-d");
        assert_eq!(
            standing(&log.lead()),
            rerouted,
            "a turn's or a helper's move"
        );

        log.reroute(Some(&lead), "session", "model-e");
        log.switch(&lead, first, "model-f", "account-2");
        assert_eq!(
            standing(&log.lead()),
            (
                first.to_owned(),
                Some("account-2".to_owned()),
                "model-f".to_owned()
            ),
            "the newer switch's model wins"
        );
    }
}
