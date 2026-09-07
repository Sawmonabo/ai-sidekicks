// The deep-link pending-invite namespace, answered from the scenario.
//
// FIVE OPERATIONS AND ONE OBJECT, because they are one lifecycle and not five reads.
// A pending invitation arrives on one feed, an act is performed on it by reference,
// and what that act produced arrives on a second feed — so the fixture that stands in
// for the namespace has to REMEMBER which references it has handed out and which feed
// is listening. A per-operation helper could not: each would have to re-derive the
// state from the scenario and none could see the confirm the other served.
//
// SO IT IS AN INSTANCE PER ENGINE, NEVER A MODULE-LEVEL HOLDER. `createFixtureGrowthPort`
// builds one per bridge, and two windows on two scenarios each have their own room —
// which is the same rule the collaboration models' holder keeps for the same reason.
//
// AND TWO HANDLE TABLES, NOT ONE, because the namespace has two brands. An
// invitation is addressed by the reference its preview minted; a deep link whose
// preview never reached the control plane minted none, and the retry that re-drives
// it names the opaque ATTEMPT handle instead. One table indexed by both served every
// legitimate retry the unscripted refusal — its handle was never a key — and would
// have answered a colliding one from the wrong entry.
//
// THE REFERENCE IS THE FIXTURE'S OWN AND CARRIES NOTHING. `Plan-023 §Invariants`
// I-023-10 makes it opaque, single-use and TTL-bounded, and a fixture standing in for
// main keeps the first two of those by construction: the reference is the scenario's
// own scripted string, and a second confirm on one finds nothing because the entry is
// consumed when the act is dispatched. There is no TTL here and deliberately none —
// expiry is a clock rule main owns, and a fixture that expired references would make a
// screenshot depend on how long a person looked at it.
//
// A DISMISS RELEASES RATHER THAN REFUSES. `Spec-002 §Required Behavior` has no decline
// verb, so dismissing is local by definition: the entry goes and no outcome is
// published, because nothing happened that anyone is owed an answer about.
//
// AND A FRAME'S TICK IS A DELIVERY MOMENT, NOT AN ADMISSION TEST. A frame carries an
// `atMs` measured from scenario start, exactly as a beat does, and a fixture that read
// that tick only when a feed OPENED served whichever frames were already due and never
// looked again: a deep link scripted to arrive after the console has settled — the
// ordinary case for anything a person navigates to — was filtered out at subscription
// and delivered by nothing afterwards, because this namespace watched neither the
// engine nor the clock. So delivery hangs off scenario ADVANCEMENT, which is the one
// thing that moves the frozen clock, and the due rule below has ONE home with two
// triggers: a feed opening takes everything due so far, and an advance takes what the
// tick it landed on newly made due. Nothing here polls and nothing here arms a timer —
// a fixture that armed one would be a second clock, which is what `scenario-engine.ts`
// exists to prevent.
//
// AND THE TWO TABLES ARE MERGED BY TICK, NOT CONCATENATED. Both walks answer one feed
// and the adapter above preserves feed order, so the order this namespace releases
// arrivals in IS the order a person meets them. Handing back every due invitation and
// then every due attempt put a prompt scripted for tick 100 behind an invitation
// scripted for tick 200 whenever one advance made both due — a scenario reading
// backwards on screen while every frame in it was correct. The merge below is the fix
// and it is one comparison rather than a sort per table, because two sorts cannot state
// what happens when the two tables tie.

import { FixtureGrowthStream } from "./fixture-growth-stream.js";
import type { Unsubscribe } from "../../core/index.js";
import { growthUnscriptedReply, type GrowthOutcome } from "../growth-port/index.js";
import type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInviteState,
} from "../growth-values/index.js";
import type {
  ScenarioEngine,
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
} from "../scenario-runtime/index.js";

/** What one scripted reference can still produce. Consumed by the act it answers. */
interface PendingEntry {
  readonly frame: ScenarioPendingInviteFrame;
  /** True once an act has been dispatched on this reference. */
  isSpent: boolean;
}

/** What one scripted attempt handle can still produce. Consumed by its retry. */
interface AttemptEntry {
  readonly frame: ScenarioPendingInviteAttemptFrame;
  /** True once the retry has been driven on this handle. */
  isSpent: boolean;
}

/**
 * Where each brand sits when two arrivals fall due on one tick.
 *
 * An invitation before an unreachable deep link, because the first is something a
 * person can answer outright and the second is a prompt to try again — a feed that led
 * with the retry would put the weaker of the two first. These two values order nothing
 * else: they are read by {@link mergeDueArrivals} and by nothing above it.
 */
const INVITATION_ARRIVAL_RANK = 0;
const ATTEMPT_ARRIVAL_RANK = 1;

/**
 * One arrival that has fallen due, carrying the keys its position on the feed needs.
 *
 * A tick alone cannot order the feed: two tables are walked and one advance can make
 * an entry in each of them due, so the brand rank travels beside the tick rather than
 * being decided by whichever table happened to be walked first.
 */
interface DueArrival {
  readonly atMs: number;
  /** {@link INVITATION_ARRIVAL_RANK} or {@link ATTEMPT_ARRIVAL_RANK}. */
  readonly rank: number;
  readonly state: GrowthPendingInviteState;
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
 * Pure, and it copies before sorting: the caller composes the array from two `map`
 * results, and sorting a caller's array in place is a habit that is wrong the first
 * time somebody passes one they still hold.
 */
function mergeDueArrivals(arrivals: readonly DueArrival[]): readonly GrowthPendingInviteState[] {
  return [...arrivals]
    .sort((left, right) =>
      left.atMs === right.atMs ? left.rank - right.rank : left.atMs - right.atMs,
    )
    .map((arrival) => arrival.state);
}

/**
 * The fixture's stand-in for the main process's pending-invite lifecycle.
 *
 * A class with private fields: it owns two open feeds and two handle tables — one per
 * brand, since a reference and an attempt are accepted by different acts — so it owns
 * a teardown, and a suite drives every arm without a bridge at all.
 */
export class FixturePendingInvites {
  readonly #engine: ScenarioEngine;
  readonly #entriesByReference = new Map<string, PendingEntry>();
  /**
   * The outstanding deep links a retry addresses, keyed by their OWN brand.
   *
   * A second table rather than a second use of the one above, which is the whole
   * correction: `retryPending` is dispatched on an attempt handle and the references
   * beside it belong to a different brand accepted by different acts, so a lookup
   * that indexed both by one string served every legitimate retry the unscripted
   * refusal and would serve a colliding one the wrong entry.
   */
  readonly #attemptsByHandle = new Map<GrowthInviteAttempt, AttemptEntry>();
  readonly #pendingFeeds = new Set<FixtureGrowthStream<GrowthPendingInviteState>>();
  readonly #outcomeFeeds = new Set<FixtureGrowthStream<GrowthInviteOutcome>>();
  readonly #unsubscribeFromAdvances: Unsubscribe;
  /**
   * The tick every OPEN feed has already been served through.
   *
   * One number rather than a per-entry delivered flag, because the two triggers have
   * to compose: a feed opened after a frame fell due takes it from the open-time walk,
   * and a per-entry flag set by that walk would then stop the advance walk delivering
   * it to the feeds that were open before. A watermark asks the question the other way
   * round — what did the feeds already open not get — and the two never overlap.
   */
  #deliveredThroughMs: number;

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
    for (const frame of engine.scenario.pendingInvites ?? []) {
      this.#entriesByReference.set(frame.invite.reference, { frame, isSpent: false });
    }
    for (const frame of engine.scenario.pendingInviteAttempts ?? []) {
      this.#attemptsByHandle.set(frame.attempt, { frame, isSpent: false });
    }
    this.#deliveredThroughMs = engine.progress.elapsedMs;
    this.#unsubscribeFromAdvances = engine.subscribeToAdvances((elapsedMs) => {
      this.#deliverNewlyDue(elapsedMs);
    });
  }

  /**
   * Open the pending feed and hand it every invitation already due.
   *
   * Pushed BEFORE the caller iterates, which the stream holds in its queue — the deep
   * link's own shape: a protocol fire happens before any surface mounts, so a feed
   * that only delivered what arrived after subscription would deliver nothing at all
   * for the case this namespace exists to serve.
   */
  public openPendingFeed(): FixtureGrowthStream<GrowthPendingInviteState> {
    const feed = new FixtureGrowthStream<GrowthPendingInviteState>();
    this.#pendingFeeds.add(feed);
    // Everything due so far. There is no earlier tick for a feed opening now to be
    // past, which is what the unbounded lower edge says — the bound that matters is
    // the upper one, and it is the clock's own reading rather than this object's
    // watermark, because that watermark describes the feeds that were ALREADY open.
    for (const arrival of this.#statesDueBetween(
      Number.NEGATIVE_INFINITY,
      this.#engine.progress.elapsedMs,
    )) {
      feed.push(arrival);
    }
    return feed;
  }

  /** Open the outcome feed. Empty until an act is dispatched on some reference. */
  public openOutcomeFeed(): FixtureGrowthStream<GrowthInviteOutcome> {
    const feed = new FixtureGrowthStream<GrowthInviteOutcome>();
    this.#outcomeFeeds.add(feed);
    return feed;
  }

  /**
   * Confirm one reference, and publish what the scenario says that produced.
   *
   * The reference is SPENT here rather than on the outcome, because that is what
   * single-use means: a second press while the first attempt is unsettled must find
   * nothing, and an entry released only when an answer came back would admit exactly
   * the double acceptance the invariant forbids.
   */
  public confirm(reference: string): GrowthOutcome<undefined> {
    return this.#dispatch(reference);
  }

  /**
   * Re-drive the preview of one outstanding deep link, by its own attempt handle.
   *
   * WHAT IT PRODUCES IS A PENDING STATE AND NEVER AN OUTCOME. A retry re-runs the
   * PREVIEW, which is the step that never happened on this arm, so its answer lands
   * on the same feed the deep link arrived on — and the invitation it mints joins the
   * reference table, so the acts that spend a reference reach it exactly as they
   * reach one delivered by the clock.
   *
   * The handle is spent by the retry: main keys each failed deep link by one handle,
   * and a second retry on it addresses a preview that has already been re-driven.
   */
  public retry(attempt: GrowthInviteAttempt): GrowthOutcome<undefined> {
    const entry = this.#attemptsByHandle.get(attempt);
    if (entry === undefined || entry.isSpent) {
      return growthUnscriptedReply("inviteRetryPending", "invite.retryPending");
    }
    entry.isSpent = true;
    const retried = entry.frame.onRetry;
    // Stamped with the tick it arrives at rather than the attempt's own: this is a
    // delivery moment, and a feed opening later takes it from the open-time walk for
    // the same reason it takes any other invitation still pending.
    this.#entriesByReference.set(retried.invite.reference, {
      frame: { atMs: this.#engine.progress.elapsedMs, ...retried },
      isSpent: false,
    });
    for (const feed of this.#pendingFeeds) {
      feed.push({ status: "ready", ...retried.invite });
    }
    return { status: "served", value: undefined };
  }

  /** Put one invitation away. Local, silent, and no outcome is published. */
  public dismiss(reference: string): GrowthOutcome<undefined> {
    if (!this.#entriesByReference.delete(reference)) {
      return growthUnscriptedReply("inviteDismissPending", "invite.dismissPending");
    }
    return { status: "served", value: undefined };
  }

  /** Close every open feed. Called when the bridge holding this fixture is retired. */
  public dispose(): void {
    this.#unsubscribeFromAdvances();
    for (const feed of this.#pendingFeeds) {
      feed.close();
    }
    for (const feed of this.#outcomeFeeds) {
      feed.close();
    }
    this.#pendingFeeds.clear();
    this.#outcomeFeeds.clear();
  }

  /**
   * Hand every open feed the frames this advance newly made due.
   *
   * The watermark moves FIRST and unconditionally, so a scenario advanced while no
   * feed is open does not leave those ticks pending for whichever feed opens next —
   * that feed's own open-time walk already covers them, and delivering them twice is
   * the failure this object's single due rule exists to prevent.
   */
  #deliverNewlyDue(elapsedMs: number): void {
    const servedThrough = this.#deliveredThroughMs;
    // `Math.max` rather than a plain assignment: the frozen clock only moves forward,
    // and a watermark that could be walked back by a zero-delta advance would re-serve
    // whatever the previous one had just handed out.
    this.#deliveredThroughMs = Math.max(servedThrough, elapsedMs);
    for (const arrival of this.#statesDueBetween(servedThrough, elapsedMs)) {
      for (const feed of this.#pendingFeeds) {
        feed.push(arrival);
      }
    }
  }

  /**
   * Every unspent entry whose tick falls in `(afterMs, throughMs]`, as a feed state.
   *
   * ONE due rule with two callers, and the half-open lower edge is what lets them
   * compose: an entry is either already behind an open feed's watermark or it is not,
   * so no frame reaches one feed twice and none is skipped between the two triggers.
   * A SPENT entry is excluded on both, because the act that spent it is the answer and
   * re-offering it would put a consumed handle on screen.
   *
   * BOTH TABLES WALK HERE, and the discriminant each arm is keyed by is stamped in
   * this one place: a scenario stays a table of invitations and of outstanding deep
   * links rather than of wire states. What the two walks produce is then MERGED by
   * {@link mergeDueArrivals} rather than concatenated, so the two kinds arrive on one
   * feed in the order the scenario scheduled them rather than in table order.
   */
  #statesDueBetween(afterMs: number, throughMs: number): readonly GrowthPendingInviteState[] {
    const isDue = (atMs: number, isSpent: boolean): boolean =>
      !isSpent && atMs > afterMs && atMs <= throughMs;
    const invitations = [...this.#entriesByReference.values()]
      .filter((entry) => isDue(entry.frame.atMs, entry.isSpent))
      .map<DueArrival>((entry) => ({
        atMs: entry.frame.atMs,
        rank: INVITATION_ARRIVAL_RANK,
        state: { status: "ready", ...entry.frame.invite },
      }));
    const attempts = [...this.#attemptsByHandle.values()]
      .filter((entry) => isDue(entry.frame.atMs, entry.isSpent))
      .map<DueArrival>((entry) => ({
        atMs: entry.frame.atMs,
        rank: ATTEMPT_ARRIVAL_RANK,
        state: { status: "unavailable", retryable: true, attempt: entry.frame.attempt },
      }));
    return mergeDueArrivals([...invitations, ...attempts]);
  }

  /**
   * Publish the outcome one reference names, spending it on the first act only.
   *
   * A SECOND CONFIRMATION IS SERVED ONLY WHERE THE SCENARIO SCRIPTS ONE, which is the
   * recovery the `unavailable` OUTCOME arm offers: that answer says the acceptance
   * never reached the control plane, so main may still hold the entry and the act put
   * again is the same confirmation. Absent an `onReconfirm` the entry stays
   * single-use and the second act finds nothing, which is the ordinary posture.
   */
  #dispatch(reference: string): GrowthOutcome<undefined> {
    const entry = this.#entriesByReference.get(reference);
    const reconfirmation = entry?.isSpent === true ? entry.frame.onReconfirm : undefined;
    if (entry === undefined || (entry.isSpent && reconfirmation === undefined)) {
      // The SCENARIO's gap, or a reference already used — and both take the
      // unscripted refusal rather than `wire-unregistered`, on the rule
      // `growthUnscriptedReply`'s own header states: this fixture SERVES the
      // operation, so naming an unbuilt wire would send a reader to a document owing
      // something the fixture already stands in for.
      return growthUnscriptedReply("inviteConfirmPending", "invite.confirmPending");
    }
    entry.isSpent = true;
    this.#publishOutcome(reconfirmation ?? entry.frame.onConfirm);
    return { status: "served", value: undefined };
  }

  /** Hand one outcome to every open outcome feed. */
  #publishOutcome(outcome: GrowthInviteOutcome): void {
    for (const feed of this.#outcomeFeeds) {
      feed.push(outcome);
    }
  }
}
