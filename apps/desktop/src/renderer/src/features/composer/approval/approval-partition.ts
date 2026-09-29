// The pure folds over this pane's reads: what each section renders from, and how far
// each read got.
//
// None of them touches React and none of them performs a read, which is the whole
// reason they are here: a fold over an answered read is a value question with a table
// of cases, and it is testable as one only while it is not wrapped in a render.
//
// THE PHASE IS CARRIED, NEVER FLATTENED. `partitionRecords` answers empty arrays for
// every phase that is not `answered`, and that is correct only because its callers
// render the PHASE beside the arrays rather than the arrays alone. "The read is in
// flight" and "the read answered and found none" are different next moves, and a
// section that showed its empty copy for the first would tell an operator that
// nothing needs them while the read is still running.

import { type ApprovalRecord } from "@renderer/services/approvals/approval-records.js";
import { type ConsoleEntity } from "@renderer/console/store/entities/entities.js";
import { providerAskFor, type ProviderAsk } from "./provider-ask.js";

/**
 * Where one read has got to.
 *
 * Two arms because these are two different sentences and collapsing them is wrong: a
 * read is in flight, or a read answered (with however many rows, including none).
 */
export type ReadPhase<TRow> =
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    };

/** One answered read, split into the cards waiting and the ones already decided. */
export interface PartitionedApprovals {
  readonly pending: readonly ApprovalRecord[];
  readonly history: readonly ApprovalRecord[];
}

/**
 * The provider-ask origin of every projected approval, keyed by request id.
 *
 * Built over the whole partition rather than per rendered record: the partition's
 * identity changes only when an approval event lands, so one pass per fold serves
 * both lists, where a per-record lookup would rebuild on every render of either.
 *
 * @consumedBy the approvals pane's provider ask framing
 */
export function providerAsksIn(
  entities: Readonly<Record<string, ConsoleEntity>>,
): ReadonlyMap<string, ProviderAsk> {
  const asks = new Map<string, ProviderAsk>();
  for (const [approvalRequestId, entity] of Object.entries(entities)) {
    const ask = providerAskFor(entity);
    if (ask !== undefined) {
      asks.set(approvalRequestId, ask);
    }
  }
  return asks;
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
