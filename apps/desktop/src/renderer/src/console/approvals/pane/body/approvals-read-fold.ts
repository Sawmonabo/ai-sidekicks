// The pure folds over this pane's two reads: what each section renders from, and how
// far each of them got.
//
// Split out of `ApprovalsPaneBody.tsx`, which composes six surfaces over two reads
// and had grown these folds inline. None of them touches React and none of them
// performs a read, which is the whole reason they are here: a fold over an answered
// read is a value question with a table of cases, and it is testable as one only
// while it is not wrapped in a render.
//
// THE PHASE IS CARRIED, NEVER FLATTENED. `partitionRecords` answers empty arrays for
// every phase that is not `answered`, and that is correct only because its callers
// render the PHASE beside the arrays rather than the arrays alone. The rule being kept
// is that "nobody asked", "the read is in flight", "the read answered and found none",
// and "the read was refused" are four different next moves, and a section that showed
// its empty copy for the first, second and fourth would tell an operator that nothing
// needs them during an outage.

import { type ConsoleRefusal } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";

/**
 * Where one read has got to.
 *
 * Four arms because these are four different sentences and collapsing any two of them
 * is wrong: nobody has asked, a read is in flight, a read answered (with however many
 * rows, including none), and a read was refused.
 */
export type ReadPhase<TRow> =
  | { readonly status: "not-checked" }
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** One answered read, split into the cards waiting and the ones already decided. */
export interface PartitionedApprovals {
  readonly pending: readonly ApprovalRecord[];
  readonly history: readonly ApprovalRecord[];
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
export function partitionRecords(phase: ReadPhase<ApprovalRecord>): PartitionedApprovals {
  if (phase.status !== "answered") {
    return NO_RECORDS;
  }
  const pending: ApprovalRecord[] = [];
  const history: ApprovalRecord[] = [];
  for (const record of phase.rows) {
    if (record.state === "pending") {
      pending.push(record);
    } else {
      history.push(record);
    }
  }
  return { pending, history };
}

/** Why a read got no further, or `undefined` for every phase that is not a refusal. */
export function refusalOfPhase<TRow>(phase: ReadPhase<TRow>): ConsoleRefusal | undefined {
  return phase.status === "refused" ? phase.refusal : undefined;
}
