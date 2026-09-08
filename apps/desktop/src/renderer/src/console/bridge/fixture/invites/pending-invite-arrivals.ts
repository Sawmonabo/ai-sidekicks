// Which scripted deep links have fallen due, and the order one feed releases them in.
//
// SPLIT FROM `pending-invites.ts` on the seam that file's own header already
// draws: that module is the LIFECYCLE — the feeds it holds open, the acts it answers,
// the watermark that says what the open feeds have covered — and this one is the pure
// question underneath it, which is what a set of scripted tables contributes to a feed
// between two ticks. Neither half knows the other's: a suite can drive the merge over
// three hand-built tables without opening a feed, and the lifecycle above reads one
// answer rather than three walks it would have to keep in step by hand.
//
// THE THREE TABLES ARE MERGED BY TICK, NOT CONCATENATED. All three walks answer one
// feed and the adapter above preserves feed order, so the order released here IS the
// order a person meets these arrivals in. Handing back every due invitation and then
// every due attempt put a prompt scripted for tick 100 behind an invitation scripted
// for tick 200 whenever one advance made both due — a scenario reading backwards on
// screen while every frame in it was correct. The merge below is the fix, and it is one
// comparison rather than a sort per table, because three sorts cannot state what
// happens when two of the tables tie.
//
// AND AN ARRIVAL CARRIES WHAT ITS DELIVERY RECORDS. Two of the three brands are spent
// by an ACT and outlive any number of deliveries; the third is spent by the delivery
// itself. Rather than a second walk deciding which is which — a walk free to disagree
// with this one about what was due — each arrival leaves here carrying the one thing
// its own table records once it has been handed over.

import type { GrowthPendingInviteState } from "../../growth-values/index.js";
import type {
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
  ScenarioPendingInviteRefusedFrame,
} from "../../scenario-runtime/index.js";

/** What one scripted reference can still produce. Consumed by the act it answers. */
export interface PendingEntry {
  readonly frame: ScenarioPendingInviteFrame;
  /** True once an act has been dispatched on this reference. */
  isSpent: boolean;
}

/** What one scripted attempt handle can still produce. Consumed by its retry. */
export interface AttemptEntry {
  readonly frame: ScenarioPendingInviteAttemptFrame;
  /** True once the retry has been driven on this handle. */
  isSpent: boolean;
}

/**
 * One scripted refusal, and whether this playback has already delivered it.
 *
 * SPENT BY ITS OWN DELIVERY, which is the one place this entry differs from the two
 * above: those are spent by an ACT, because main holds each handle until one is put
 * and re-offers it to any feed that opens meanwhile. A refusal mints no handle, so
 * main holds nothing for it and a re-opened feed brings nothing back — and the queue
 * that receives it cannot recognise a duplicate of one, having no handle to key on, so
 * a second feed re-served this row would put a second copy of one terminal explanation
 * in front of a person. Delivering once is therefore the honest reading, not an economy.
 */
export interface RefusedEntry {
  readonly frame: ScenarioPendingInviteRefusedFrame;
  /** True once this refusal has reached the feeds one due window served. */
  isSpent: boolean;
}

/**
 * The three tables one playback holds, as the walk below reads them.
 *
 * Iterables rather than the containers themselves, because how each is INDEXED is the
 * lifecycle's business and not this walk's: two are keyed by the handle their own act
 * is dispatched on, and the third is keyed by nothing at all.
 */
export interface PendingInviteEntryTables {
  readonly invitations: Iterable<PendingEntry>;
  readonly attempts: Iterable<AttemptEntry>;
  readonly refusals: Iterable<RefusedEntry>;
}

/**
 * Where each brand sits when two arrivals fall due on one tick.
 *
 * An invitation before an unreachable deep link, because the first is something a
 * person can answer outright and the second is a prompt to try again — a feed that led
 * with the retry would put the weaker of the two first. A refusal comes last of the
 * three for the same reading carried one step further: it is the only arm that offers
 * nothing to press, so a feed that led with it would put the arrival a person can do
 * least about in front of the ones they can act on. These three values order nothing
 * else: they are read by {@link mergeDueArrivals} and by nothing outside this module.
 */
const INVITATION_ARRIVAL_RANK = 0;
const ATTEMPT_ARRIVAL_RANK = 1;
const REFUSAL_ARRIVAL_RANK = 2;

/**
 * One arrival that has fallen due, carrying the keys its position on the feed needs.
 *
 * A tick alone cannot order the feed: three tables are walked and one advance can make
 * an entry in each of them due, so the brand rank travels beside the tick rather than
 * being decided by whichever table happened to be walked first.
 */
export interface DueArrival {
  readonly atMs: number;
  /**
   * {@link INVITATION_ARRIVAL_RANK}, {@link ATTEMPT_ARRIVAL_RANK} or
   * {@link REFUSAL_ARRIVAL_RANK}.
   */
  readonly rank: number;
  readonly state: GrowthPendingInviteState;
  /**
   * What the table this arrival came from records once it has been handed over.
   *
   * A no-op for the two handle-bearing brands, which are spent by an ACT rather than
   * by a delivery, and the spend for a refusal, which has no handle and is therefore
   * delivered once. It rides the arrival rather than being a fourth walk, so the one
   * due rule here stays the only place that decides what a window has covered.
   */
  readonly recordDelivered: () => void;
}

/** What an arrival whose table is spent by an act rather than by a delivery records. */
function recordNothingOnDelivery(): void {
  // Deliberately empty: an invitation and an attempt outlive their own delivery, so
  // the feed handing one over says nothing about whether it may be handed over again.
}

/**
 * The due arrivals in the order a person meets them: by tick, then by brand.
 *
 * ONE MERGE RATHER THAN A SORT PER TABLE, because the interesting case is the one a
 * per-table sort cannot express — two entries from two tables agreeing on `atMs`. The
 * third key is the order each table declared its entries in, and it is not written as a
 * comparison because it does not have to be: `Array.prototype.sort` is stable, so
 * entries agreeing on both keys above keep the order they arrived in.
 *
 * Pure, and it copies before sorting: the caller composes the array from three `map`
 * results, and sorting a caller's array in place is a habit that is wrong the first
 * time somebody passes one they still hold.
 */
function mergeDueArrivals(arrivals: readonly DueArrival[]): readonly DueArrival[] {
  return [...arrivals].sort((left, right) =>
    left.atMs === right.atMs ? left.rank - right.rank : left.atMs - right.atMs,
  );
}

/**
 * Every unspent entry whose tick falls in `(afterMs, throughMs]`, as a feed arrival.
 *
 * ONE due rule with two callers above, and the half-open lower edge is what lets them
 * compose: an entry is either already behind an open feed's watermark or it is not, so
 * no frame reaches one feed twice and none is skipped between the two triggers. A SPENT
 * entry is excluded on all three, because the thing that spent it is the answer, and
 * re-offering it would put a consumed handle — or a duplicate of one terminal
 * explanation — on screen.
 *
 * ALL THREE TABLES WALK HERE, and the discriminant each arm is keyed by is stamped in
 * this one place: a scenario stays a table of invitations, of outstanding deep links and
 * of refusals rather than of wire states.
 *
 * A REFUSED ARRIVAL MINTS NOTHING, which is the half its own arm exists for: it is built
 * out of the scenario's code and sentence alone, and neither this walk nor the delivery
 * that follows it writes into the reference table — so no act can ever be dispatched on
 * one, exactly as the wire has it.
 */
export function dueArrivalsBetween(
  tables: PendingInviteEntryTables,
  afterMs: number,
  throughMs: number,
): readonly DueArrival[] {
  const isDue = (atMs: number, isSpent: boolean): boolean =>
    !isSpent && atMs > afterMs && atMs <= throughMs;
  const invitations = [...tables.invitations]
    .filter((entry) => isDue(entry.frame.atMs, entry.isSpent))
    .map<DueArrival>((entry) => ({
      atMs: entry.frame.atMs,
      rank: INVITATION_ARRIVAL_RANK,
      state: { status: "ready", ...entry.frame.invite },
      recordDelivered: recordNothingOnDelivery,
    }));
  const attempts = [...tables.attempts]
    .filter((entry) => isDue(entry.frame.atMs, entry.isSpent))
    .map<DueArrival>((entry) => ({
      atMs: entry.frame.atMs,
      rank: ATTEMPT_ARRIVAL_RANK,
      state: { status: "unavailable", retryable: true, attempt: entry.frame.attempt },
      recordDelivered: recordNothingOnDelivery,
    }));
  const refusals = [...tables.refusals]
    .filter((entry) => isDue(entry.frame.atMs, entry.isSpent))
    .map<DueArrival>((entry) => ({
      atMs: entry.frame.atMs,
      rank: REFUSAL_ARRIVAL_RANK,
      state: { status: "refused", ...entry.frame.refusal },
      recordDelivered: () => {
        entry.isSpent = true;
      },
    }));
  return mergeDueArrivals([...invitations, ...attempts, ...refusals]);
}
