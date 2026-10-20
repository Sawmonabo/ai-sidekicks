//! Reads which agent a run is for, from the session's log: the agent its `agent.run.queued` names,
//! the one minted from a saved definition with it, else the session's lead, for a lead run queued
//! before a run named its agent; the session's lead, which `session.created` names, and the
//! provider and account it runs on now; and whether the log names an agent at all.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::IdError;

use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::events::session::read::readable_event_sql;

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

static SELECT_LEAD_AGENT_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    format!(
        "
  SELECT json_extract(payload, '$.mainAgent.agentId') AS agent_id
   FROM session_events
  WHERE session_id = ? AND type = '{session_created}'"
    )
});

// The lead's binding now: the newest readable switch of the lead that landed, else the binding the
// session was created with. A switch's account is the one it landed on, since its `to` may follow
// the provider's current account.
static SELECT_LEAD_BINDING_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    let binding_changed = SessionEventType::AgentProviderBindingChanged.as_str();
    let readable_changed = readable_event_sql("changed");
    let readable_created = readable_event_sql("created");
    let readable_born = readable_event_sql("born");
    format!(
        "SELECT provider_name, provider_account_id FROM (
    SELECT json_extract(changed.payload, '$.to.providerName') AS provider_name,
           json_extract(changed.payload, '$.landedProviderAccountId') AS provider_account_id,
           changed.sequence AS sequence
      FROM session_events AS changed JOIN session_events AS created
        ON created.session_id = changed.session_id AND created.type = '{session_created}'
     WHERE changed.session_id = @session_id
       AND changed.type = '{binding_changed}'
       AND json_extract(changed.payload, '$.agentId')
           = json_extract(created.payload, '$.mainAgent.agentId')
       AND {readable_changed}
       AND {readable_created}
    UNION ALL
    SELECT json_extract(born.payload, '$.mainAgent.binding.providerName'),
           json_extract(born.payload, '$.mainAgent.binding.providerAccountId'),
           born.sequence
      FROM session_events AS born
     WHERE born.session_id = @session_id AND born.type = '{session_created}'
       AND {readable_born})
  ORDER BY sequence DESC
  LIMIT 1"
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

/// The provider the session's lead runs on now and the account it is bound to, `None` for the
/// provider's current account, read from the log's events before `read_bound` outside its skipped
/// ranges; `None` for a session whose readable log holds no `session.created`. Fails when SQLite
/// refuses the read or a stored name or id does not read as its type.
pub(crate) fn read_lead_binding(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
) -> rusqlite::Result<Option<(ProviderId, Option<ProviderAccountId>)>> {
    reader
        .prepare_cached(&SELECT_LEAD_BINDING_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@read_bound": read_bound,
            },
            |row| {
                Ok((
                    text_column(row, 0, closed_word::<ProviderId>)?,
                    optional_text_column(row, 1, closed_word::<ProviderAccountId>)?,
                ))
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

/// The statements [`RunAgentReader`] runs: the run's agent and the session's lead.
pub(crate) const RUN_AGENT_STATEMENT_CAPACITY: usize = 2;

/// Why the agent of a run, or a session's lead, could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunAgentReadError {
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
    /// The log names an agent by text that is no agent id.
    #[error("the session's log names an agent by text that is no agent id")]
    MalformedAgentId(#[source] IdError),
    /// The read itself failed.
    #[error("reading the session's log for an agent failed")]
    Read(#[from] rusqlite::Error),
}

/// Reads the agent of a run, and a session's lead, from the session's log on the reader the
/// caller passes.
pub(crate) struct RunAgentReader<'connection> {
    /// The daemon's read-only connection.
    reader: &'connection Connection,
}

impl<'connection> RunAgentReader<'connection> {
    /// A reader over `reader`, the daemon's read-only connection.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
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
    pub(crate) fn read_agent(
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
}
