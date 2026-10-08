// The superseded mark a rollback writes onto the rows a store already holds. The daemon stamps
// every row it serves or streams after a rollback, so a row arriving later carries its own mark;
// the rows held before the rollback arrived are marked here, once, when it is admitted. The mark
// is the row's own from then on, so letting the boundary row go keeps it.
//
// The rule is the daemon's: a rollback rewinding epoch E to position P cuts E at P and every
// earlier epoch of the run at the lower of its own cut and P, since an earlier epoch's surviving
// prefix is part of the history the rollback rewound. A row above its epoch's cut is superseded,
// the row at the cut survives, and a later epoch is never reached, because re-execution reuses
// positions.

import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "@ai-sidekicks/contracts/transcript/row";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";

import { readWireNumber } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "../../entities/vocabulary.js";

/**
 * The held rows with the superseded marks `event` writes, or `held` itself when `event` is no
 * rollback or marks no row. Rows are replaced, never mutated, so a view keyed on a row's identity
 * sees the change.
 */
export function markSupersededByRollback(
  held: readonly ProjectedSessionEvent[],
  event: ProjectedSessionEvent,
): readonly ProjectedSessionEvent[] {
  const cut = rollbackCutOf(event);
  if (cut === undefined) {
    return held;
  }
  let marked: ProjectedSessionEvent[] | undefined;
  held.forEach((row, index) => {
    const remarked = rowUnderCut(row, cut);
    if (remarked !== row) {
      marked ??= [...held];
      marked[index] = remarked;
    }
  });
  return marked ?? held;
}

/** Where one rollback cuts its run: the epoch it rewound and the position it rewound to. */
interface RollbackCut {
  readonly runId: string;
  readonly epoch: number;
  readonly targetPosition: number;
}

function rollbackCutOf(event: ProjectedSessionEvent): RollbackCut | undefined {
  if (event.kind !== TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE || event.runStamp === undefined) {
    return undefined;
  }
  const runId = transcriptRunIdOf(event.payload);
  const targetPosition = readWireNumber(event.payload?.["targetPosition"]);
  return runId === undefined || targetPosition === undefined
    ? undefined
    : { runId, epoch: event.runStamp.epoch, targetPosition };
}

/** The row with its epoch's cut lowered to `cut`, or the row itself when that changes nothing. */
function rowUnderCut(row: ProjectedSessionEvent, cut: RollbackCut): ProjectedSessionEvent {
  const stamp = row.runStamp;
  if (
    stamp === undefined ||
    stamp.epoch > cut.epoch ||
    transcriptRunIdOf(row.payload) !== cut.runId
  ) {
    return row;
  }
  const heldCut = stamp.superseded?.targetPosition;
  const targetPosition = Math.min(heldCut ?? cut.targetPosition, cut.targetPosition);
  if (stamp.position <= targetPosition || heldCut === targetPosition) {
    return row;
  }
  return { ...row, runStamp: { ...stamp, superseded: { targetPosition } } };
}
