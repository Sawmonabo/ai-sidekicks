// The pure folds over the approval reads: what each list renders from, and how far
// each read got.
//
// None of them touches React and none of them performs a read, which is the whole
// reason they are here: a fold over an answered read is a value question with a table
// of cases, and it is testable as one only while it is not wrapped in a render.
//
// THE PHASE IS CARRIED, NEVER FLATTENED. `partitionApprovalRecords` answers empty arrays for
// every phase that is not `answered`, and that is correct only because its callers
// render the PHASE beside the arrays rather than the arrays alone. "The read is in
// flight" and "the read answered and found none" are different next moves, and a
// section that showed its empty copy for the first would tell an operator that
// nothing needs them while the read is still running.

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts";

import { type ReadPhase } from "@renderer/lib/read-phase.js";

/** One answered read, split into the cards waiting and the ones already decided. */
export interface PartitionedApprovals {
  readonly pending: readonly ApprovalProjectionRow[];
  readonly history: readonly ApprovalProjectionRow[];
}

/** Neither list has a member until a read has answered. */
const NO_RECORDS: PartitionedApprovals = { pending: [], history: [] };

/**
 * Split one answered read into the pending cards and the history.
 *
 * A rendering of ONE read rather than two reads or a filter of the wire: every
 * record the daemon returned appears in exactly one of the two lists, so the
 * history's "drops nothing" claim survives the split.
 *
 * Both lists are empty for every other phase, and that emptiness is NOT an answer —
 * every caller renders the phase this was folded from beside them.
 */
export function partitionApprovalRecords(
  phase: ReadPhase<ApprovalProjectionRow>,
): PartitionedApprovals {
  if (phase.status !== "answered") {
    return NO_RECORDS;
  }
  const pending: ApprovalProjectionRow[] = [];
  const history: ApprovalProjectionRow[] = [];
  for (const record of phase.rows) {
    if (record.state === "pending") {
      pending.push(record);
    } else {
      history.push(record);
    }
  }
  return { pending, history };
}
