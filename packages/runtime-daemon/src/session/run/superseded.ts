// Which turns of a run an undo superseded, read from the log. Undone turns stay in the log, and
// every accepted `run.rolled_back` of the run adds its cut (`addSupersedingCut`).

import type { Database, Statement } from "better-sqlite3";

import {
  RunRolledBackEventSchema,
  type RunRolledBackEvent,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "@ai-sidekicks/contracts/transcript/row";
import {
  addSupersedingCut,
  type SupersededTurns,
} from "@ai-sidekicks/contracts/transcript/turn-attribution";

import { sessionReadBound, type DamagedFromSequenceReader } from "../../events/session/read.js";
import { outsideSkippedRangesSql } from "../../events/session/skipped-ranges.js";

/**
 * Reads one stored `run.rolled_back` payload into its contract. Throws when it does not match: the
 * log is the daemon's own, so a mismatch is a broken write, and skipping it would move every cut.
 */
export function parseStoredRollback(
  payload: unknown,
  sessionId: SessionId,
  sequence: number,
): RunRolledBackEvent {
  const parsed = RunRolledBackEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `The ${TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE} event at sequence ${String(sequence)} of session ` +
        `${sessionId} does not match its contract, so the run's history cannot be read.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

interface RunRollbackParameters {
  readonly sessionId: SessionId;
  readonly type: string;
  readonly runId: RunId;
  readonly readBound: number;
}

interface StoredRollbackRow {
  readonly sequence: number;
  readonly payload: string;
}

// Seeks the run's readable rollbacks through the event log's run-and-type index.
const SELECT_RUN_ROLLBACKS_SQL = `SELECT sequence, payload FROM session_events AS event
  WHERE session_id = @sessionId AND type = @type AND run_id = @runId
    AND sequence < @readBound AND ${outsideSkippedRangesSql("event")}
  ORDER BY sequence`;

/**
 * Prepares the read of a run's superseded turns from every rollback of it the log can read, none
 * past a damaged session's last good point (`readDamagedFromSequence`) or in a range it skipped.
 * The read throws when a stored rollback does not match its contract.
 */
export function prepareSupersededTurns(
  reader: Database,
  readDamagedFromSequence: DamagedFromSequenceReader = () => undefined,
): (sessionId: SessionId, runId: RunId) => SupersededTurns {
  const selectRunRollbacks: Statement<RunRollbackParameters, StoredRollbackRow> =
    reader.prepare(SELECT_RUN_ROLLBACKS_SQL);
  return (sessionId, runId) => {
    let turns: SupersededTurns = { runId, cuts: [] };
    const rows = selectRunRollbacks.iterate({
      sessionId,
      type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
      runId,
      readBound: sessionReadBound(readDamagedFromSequence, sessionId),
    });
    for (const row of rows) {
      const rollback = parseStoredRollback(JSON.parse(row.payload), sessionId, row.sequence);
      turns = addSupersedingCut(turns, rollback.targetPosition);
    }
    return turns;
  };
}
