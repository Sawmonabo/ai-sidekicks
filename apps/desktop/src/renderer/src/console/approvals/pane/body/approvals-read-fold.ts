// The pure folds over this pane's two reads: what each section renders from, and
// which refusal stops being this pane's business.
//
// Split out of `ApprovalsPaneBody.tsx`, which composes six surfaces over two reads
// and had grown these folds inline. None of them touches React and none of them
// performs a read, which is the whole reason they are here: a fold over an answered
// read is a value question with a table of cases, and it is testable as one only
// while it is not wrapped in a render.
//
// THE PHASE IS CARRIED, NEVER FLATTENED. `partitionRecords` answers empty arrays for
// every phase that is not `answered`, and that is correct only because its callers
// render the PHASE beside the arrays rather than the arrays alone. `Spec-023 §Console
// Design (Meridian)` rule 8 is the rule being kept: "nobody asked", "the read is in
// flight", "the read answered and found none", and "the read was refused" are four
// different next moves, and a section that showed its empty copy for the first, second
// and fourth would tell an operator that nothing needs them during an outage.

import { refusalRemedyFor, type ConsoleRefusal } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ConsoleEntity } from "../../../store/index.js";
import { providerAskFor, type ProviderAsk } from "../card/provider-ask.js";
import { type ReadPhase } from "../approvals-reader.js";

/**
 * The provider-ask origin of every projected approval, keyed by request id.
 *
 * Built over the whole partition rather than per rendered record: the partition's
 * identity changes only when an approval event lands, so one pass per fold serves
 * both lists, where a per-record lookup would rebuild on every render of either.
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

/**
 * The first refusal among these that ends the whole workspace rather than one read.
 *
 * This pane puts THREE independent calls on the wire — the approval projection, the
 * standing-rule list, and the node's declared capabilities — and any of them can come
 * back `session.not_found`. Inspecting only the first meant a session that disappeared
 * between two concurrent calls was reported inside whichever surface happened to ask
 * first and nowhere else, while the rest of the workspace went on looking live.
 *
 * ONE SELECTION AND NOT ONE ESCALATION EACH. The frame keys a banner on the refusal's
 * ORIGIN and CODE together, so three independent handovers of one vanished session
 * raise one banner where the three reads happen to agree on an origin and several
 * where they do not — and this pane's reads do not: a call that rejected wears this
 * surface's own origin while one the port refused wears the port's. A session that is
 * gone is one fact however many of this pane's reads noticed it, so the caller passes
 * its candidates in the order it wants them preferred and hands over exactly one.
 *
 * `core/refusal-remedies.ts` remains the only place that decides which codes call for
 * a banner; this asks it, and every unlisted code stays the surface's own business.
 */
export function bannerClassRefusalAmong(
  candidates: readonly (ConsoleRefusal | undefined)[],
): ConsoleRefusal | undefined {
  return candidates.find(
    (candidate) =>
      candidate !== undefined && refusalRemedyFor(candidate.code)?.rendering === "banner",
  );
}
