// The runs of one session, as its close and its purge find them, and whether a run is one of them.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";

/**
 * The ids, in one `runId` column, of the runs of the session the `@sessionId` parameter names: the
 * rows the rebuild wrote, every run its readable events name, so a run the rebuild never reached
 * past a damaged event is still found, and those that had an execution root. A damaged row's
 * payload may not be JSON, which `json_extract` would refuse, so it names no run.
 */
export const SESSION_RUN_IDS_SQL = `SELECT run_id AS runId FROM runs WHERE session_id = @sessionId
  UNION
  SELECT runId
    FROM (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END AS runId
            FROM session_events WHERE session_id = @sessionId)
   WHERE runId IS NOT NULL
  UNION
  SELECT run_id FROM run_execution_contexts WHERE session_id = @sessionId`;

/** Reads a row only while the `@runId` parameter names a run of the `@sessionId` session. */
export const RUN_IN_SESSION_SQL =
  "SELECT 1 FROM runs WHERE run_id = @runId AND session_id = @sessionId";

/** Holds only while `runId` names a run of `sessionId`. */
export function runInSessionStatement(sessionId: SessionId, runId: RunId): WriteStatement {
  return { sql: RUN_IN_SESSION_SQL, bindings: { sessionId, runId }, expectedRowCount: 1 };
}
