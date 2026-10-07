// Which turns of a run an undo superseded. Undone turns stay in the log: each accepted
// `run.rolled_back` cuts the epoch it rewound at its point, and a turn above that point is
// superseded. A later cut below an earlier epoch's point supersedes that epoch's turns down to it
// too, because the earlier epoch's surviving prefix is part of the history the later cut rewound.

import type { Database, Statement } from "better-sqlite3";

import type { SourceEpoch, SourcePosition } from "@ai-sidekicks/contracts/event/envelope";
import {
  RunRolledBackEventSchema,
  type RunRolledBackEvent,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  type SupersededMarker,
} from "@ai-sidekicks/contracts/transcript/row";

/**
 * A run's superseded turns: one cut per epoch an accepted rollback rewound, oldest first, each
 * with the point its epoch's turns above are superseded from. The k-th rollback rewound epoch k,
 * so `cuts[epoch]` is that epoch's cut.
 */
export interface SupersededTurns {
  readonly runId: RunId;
  readonly cuts: readonly { readonly sourceEpoch: SourceEpoch; readonly point: SourcePosition }[];
}

/**
 * Adds the run's next accepted rollback, which rewound epoch `turns.cuts.length` to `point`. An
 * earlier epoch's point drops to it when it lies lower, since that epoch's prefix lived on into
 * the history it rewound.
 */
export function addSupersedingCut(turns: SupersededTurns, point: SourcePosition): SupersededTurns {
  return {
    runId: turns.runId,
    cuts: [
      ...turns.cuts.map((cut) => ({
        sourceEpoch: cut.sourceEpoch,
        point: Math.min(cut.point, point),
      })),
      { sourceEpoch: turns.cuts.length, point },
    ],
  };
}

/** The marker of the run's turn at `epoch` and `position`, or `undefined` while it is current. */
export function supersededMarkerOf(
  turns: SupersededTurns,
  epoch: SourceEpoch,
  position: SourcePosition,
): SupersededMarker | undefined {
  const cut = turns.cuts[epoch];
  return cut !== undefined && position > cut.point ? { targetPosition: cut.point } : undefined;
}

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
}

interface StoredRollbackRow {
  readonly sequence: number;
  readonly payload: string;
}

// Narrows to the session's rollbacks, then keeps the run's.
const SELECT_RUN_ROLLBACKS_SQL = `SELECT sequence, payload FROM session_events
  WHERE session_id = @sessionId AND type = @type AND json_extract(payload, '$.runId') = @runId
  ORDER BY sequence`;

/**
 * Prepares the read of a run's superseded turns from every rollback of it in the log. The read
 * throws when a stored rollback does not match its contract.
 */
export function prepareSupersededTurns(
  reader: Database,
): (sessionId: SessionId, runId: RunId) => SupersededTurns {
  const selectRunRollbacks: Statement<RunRollbackParameters, StoredRollbackRow> =
    reader.prepare(SELECT_RUN_ROLLBACKS_SQL);
  return (sessionId, runId) => {
    let turns: SupersededTurns = { runId, cuts: [] };
    const rows = selectRunRollbacks.iterate({
      sessionId,
      type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
      runId,
    });
    for (const row of rows) {
      const rollback = parseStoredRollback(JSON.parse(row.payload), sessionId, row.sequence);
      turns = addSupersedingCut(turns, rollback.targetPosition);
    }
    return turns;
  };
}
