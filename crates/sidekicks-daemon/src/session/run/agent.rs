//! Reads which agent a run is for, from the session's log: the agent its `agent.run.queued` names,
//! the one minted from a saved definition with it, else the session's lead, for a lead run queued
//! before a run named its agent; and the session's lead, which `session.created` names.

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::IdError;

const SELECT_RUN_AGENT_SQL: &str = "SELECT COALESCE(
      json_extract(queued.payload, '$.agentId'),
      json_extract(queued.payload, '$.resolvedAgent.agentId'),
      (SELECT json_extract(created.payload, '$.mainAgent.agentId')
         FROM session_events AS created
        WHERE created.session_id = queued.session_id
          AND created.type = 'session.created')) AS agent_id
   FROM session_events AS queued
  WHERE queued.session_id = @session_id
    AND queued.type = 'agent.run.queued'
    AND queued.run_id = @run_id";

const SELECT_LEAD_AGENT_SQL: &str = "
  SELECT json_extract(payload, '$.mainAgent.agentId') AS agent_id
   FROM session_events
  WHERE session_id = ? AND type = 'session.created'";

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
            .prepare_cached(SELECT_LEAD_AGENT_SQL)?
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
            .prepare_cached(SELECT_RUN_AGENT_SQL)?
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
