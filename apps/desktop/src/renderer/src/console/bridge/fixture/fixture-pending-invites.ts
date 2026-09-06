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

import { FixtureGrowthStream } from "./fixture-growth-stream.js";
import { growthUnscriptedReply, type GrowthOutcome } from "../growth-port/index.js";
import type { GrowthInviteOutcome, GrowthPendingInvite } from "../growth-values/index.js";
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
  readonly #pendingFeeds = new Set<FixtureGrowthStream<GrowthPendingInvite>>();
  readonly #outcomeFeeds = new Set<FixtureGrowthStream<GrowthInviteOutcome>>();

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
    for (const frame of engine.scenario.pendingInvites ?? []) {
      this.#entriesByReference.set(frame.invite.reference, { frame, isSpent: false });
    }
  }

  /**
   * Open the pending feed and hand it every invitation already due.
   *
   * Pushed BEFORE the caller iterates, which the stream holds in its queue — the deep
   * link's own shape: a protocol fire happens before any surface mounts, so a feed
   * that only delivered what arrived after subscription would deliver nothing at all
   * for the case this namespace exists to serve.
   */
  public openPendingFeed(): FixtureGrowthStream<GrowthPendingInvite> {
    const feed = new FixtureGrowthStream<GrowthPendingInvite>();
    this.#pendingFeeds.add(feed);
    for (const entry of this.#dueEntries()) {
      feed.push(entry.frame.invite);
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
    for (const feed of this.#pendingFeeds) {
      feed.close();
    }
    for (const feed of this.#outcomeFeeds) {
      feed.close();
    }
    this.#pendingFeeds.clear();
    this.#outcomeFeeds.clear();
  }

  /** The entries whose tick has fallen due on the scenario's own frozen clock. */
  #dueEntries(): readonly PendingEntry[] {
    const { elapsedMs } = this.#engine.progress;
    return [...this.#entriesByReference.values()].filter(
      (entry) => entry.frame.atMs <= elapsedMs && !entry.isSpent,
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
