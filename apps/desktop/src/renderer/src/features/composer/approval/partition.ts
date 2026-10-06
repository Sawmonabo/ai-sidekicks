// Pure folds over the approval reads, kept out of React so they test as value cases.
// `partitionApprovalRecords` returns empty lists for every phase but `answered`, so callers
// render the phase beside them: a read in flight is not a read that found none.

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts/approval";

import { type ReadPhase } from "#renderer/lib/reads/phase.js";

/** One answered read, split into the cards waiting and the ones already decided. */
export interface PartitionedApprovals {
  readonly pending: readonly ApprovalProjectionRow[];
  readonly history: readonly ApprovalProjectionRow[];
}

const NO_RECORDS: PartitionedApprovals = { pending: [], history: [] };

/**
 * Splits one answered read into pending cards and history; every returned record lands in
 * exactly one list. Both lists are empty for any other phase, which is not an answer.
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
