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

import { FixtureGrowthStream } from "./fixture-growth-stream.js";
import type { Unsubscribe } from "../../core/index.js";
import { growthUnscriptedReply, type GrowthOutcome } from "../growth-port/index.js";
import type { GrowthInviteOutcome, GrowthPendingInviteState } from "../growth-values/index.js";
import type { ScenarioEngine, ScenarioPendingInviteFrame } from "../scenario-runtime/index.js";

/** What one scripted reference can still produce. Consumed by the act it answers. */
interface PendingEntry {
  readonly frame: ScenarioPendingInviteFrame;
  /** True once an act has been dispatched on this reference. */
  isSpent: boolean;
}

/**
 * The fixture's stand-in for the main process's pending-invite lifecycle.
 *
 * A class with private fields: it owns two open feeds and a table of references, so it
 * owns a teardown, and a suite drives every arm without a bridge at all.
 */
export class FixturePendingInvites {
  readonly #engine: ScenarioEngine;
  readonly #entriesByReference = new Map<string, PendingEntry>();
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
    for (const entry of this.#entriesDueBetween(
      Number.NEGATIVE_INFINITY,
      this.#engine.progress.elapsedMs,
    )) {
      // The scenario scripts the ready arm's own facts; the discriminant the pending
      // feed is keyed by is stamped here, so a scenario table stays a table of
      // invitations rather than of wire states.
      feed.push({ status: "ready", ...entry.frame.invite });
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
    return this.#dispatch(reference, (frame) => frame.onConfirm);
  }

  /**
   * Retry one reference.
   *
   * A retry addresses an attempt that already failed, so its entry is spent — which is
   * why this arm re-admits a spent entry and `confirm` does not. What it must not do
   * is retry an entry that was never confirmed at all, and it does not: an unspent
   * entry has no failed attempt to retry, and the fixture refuses it as unscripted
   * rather than performing a confirmation under another name.
   */
  public retry(reference: string): GrowthOutcome<undefined> {
    const entry = this.#entriesByReference.get(reference);
    if (entry === undefined || !entry.isSpent) {
      return growthUnscriptedReply("inviteRetryPending", "invite.retryPending");
    }
    this.#publishOutcome(entry.frame.onRetry ?? entry.frame.onConfirm);
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
    for (const entry of this.#entriesDueBetween(servedThrough, elapsedMs)) {
      for (const feed of this.#pendingFeeds) {
        feed.push({ status: "ready", ...entry.frame.invite });
      }
    }
  }

  /**
   * The unspent entries whose tick falls in `(afterMs, throughMs]`.
   *
   * ONE due rule with two callers, and the half-open lower edge is what lets them
   * compose: an entry is either already behind an open feed's watermark or it is not,
   * so no frame reaches one feed twice and none is skipped between the two triggers.
   * A SPENT entry is excluded on both, because the act that spent it is the answer and
   * re-offering the invitation it came from would put a consumed reference on screen.
   */
  #entriesDueBetween(afterMs: number, throughMs: number): readonly PendingEntry[] {
    return [...this.#entriesByReference.values()].filter(
      (entry) => !entry.isSpent && entry.frame.atMs > afterMs && entry.frame.atMs <= throughMs,
    );
  }

  /** Spend one unspent reference and publish the outcome it names. */
  #dispatch(
    reference: string,
    outcomeOf: (frame: ScenarioPendingInviteFrame) => GrowthInviteOutcome,
  ): GrowthOutcome<undefined> {
    const entry = this.#entriesByReference.get(reference);
    if (entry === undefined || entry.isSpent) {
      // The SCENARIO's gap, or a reference already used — and both take the
      // unscripted refusal rather than `wire-unregistered`, on the rule
      // `growthUnscriptedReply`'s own header states: this fixture SERVES the
      // operation, so naming an unbuilt wire would send a reader to a document owing
      // something the fixture already stands in for.
      return growthUnscriptedReply("inviteConfirmPending", "invite.confirmPending");
    }
    entry.isSpent = true;
    this.#publishOutcome(outcomeOf(entry.frame));
    return { status: "served", value: undefined };
  }

  /** Hand one outcome to every open outcome feed. */
  #publishOutcome(outcome: GrowthInviteOutcome): void {
    for (const feed of this.#outcomeFeeds) {
      feed.push(outcome);
    }
  }
}
