// Reads which agent a run is for, from the session's log: the agent its `run.queued` names, the
// one minted from a saved definition with it, else the session's lead, since a lead run names
// neither.

import type { Database, Statement } from "better-sqlite3";

import { AgentIdSchema, type AgentId } from "@ai-sidekicks/contracts/agent/definition";

interface RunAgentParams {
  readonly session_id: string;
  readonly run_id: string;
}

const SELECT_RUN_AGENT_SQL = `SELECT COALESCE(
      json_extract(queued.payload, '$.agentId'),
      json_extract(queued.payload, '$.resolvedAgent.agentId'),
      (SELECT json_extract(created.payload, '$.mainAgent.agentId')
         FROM session_events AS created
        WHERE created.session_id = queued.session_id
          AND created.type = 'session.created')) AS agent_id
   FROM session_events AS queued
  WHERE queued.session_id = @session_id
    AND queued.type = 'run.queued'
    AND json_extract(queued.payload, '$.runId') = @run_id`;

/** Reads the agent of a run, for a refusal that names who is running. */
export class RunAgentReader {
  readonly #selectRunAgent: Statement<RunAgentParams, { readonly agent_id: string | null }>;

  constructor(reader: Database) {
    this.#selectRunAgent = reader.prepare(SELECT_RUN_AGENT_SQL);
  }

  /**
   * The agent the run is for. Throws when the log names none: every run is queued with its agent,
   * or is the lead's run of a session born with its lead.
   */
  readAgent(sessionId: string, runId: string): AgentId {
    const row = this.#selectRunAgent.get({ session_id: sessionId, run_id: runId });
    if (row?.agent_id === undefined || row.agent_id === null) {
      throw new Error(`run "${runId}" of session "${sessionId}" has no agent its log names`);
    }
    return AgentIdSchema.parse(row.agent_id);
  }
}
