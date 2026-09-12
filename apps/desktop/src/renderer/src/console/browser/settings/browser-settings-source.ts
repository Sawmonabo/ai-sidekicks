// What the browser settings page HOLDS: two node-wide reads, and the order their
// answers are allowed to install in.
//
// The page next door is a PROJECTION — it fetches nothing, holds no store and runs no
// effect, which is what keeps it renderable in a test, a screenshot tier and an
// auxiliary window without a second code path. This module is the other half: the
// reads that feed it and the two acts that invalidate them. The mapping from what the
// growth port answered into the page's own reading shapes is `browser-settings-
// readings.ts` beside it, so this file holds only the machine.
//
// BOTH READS GO THROUGH THE GROWTH PORT AND BOTH REFUSE TODAY. Neither the node's
// browser policy nor its site-data partitions is a wire the corpus registers, so both
// ride the growth port's browser rows and the refusal a person reads is the port's
// own, citing the slate row that owes the wire. Nothing here composes a method string,
// and no scenario answers either read — the fixture serves an operation when a
// scenario states something it can be answered FROM, and a scenario states nothing
// about a node's stored bytes.
//
// THE READS ARE TRIGGERED, NOT POLLED, AND THEY ARE ORDERED. Four things start a
// refresh — the mount, the window regaining focus, the transport returning, and an act
// this page performed — and until this carrier they raced. Two calls went out per
// trigger and each published on arrival, so a partition list read BEFORE a clear could
// answer after the read that followed it and put the cleared partition back on screen,
// with a byte figure, under a control that had just reported success. The console has
// one answer to both halves of that and this module uses it rather than a counter of
// its own: `store/read/refresh-scheduler.ts`'s `RefreshScheduler` decides WHEN a read runs and
// collapses a burst into one, and `store/read/generation-latch.ts` decides which answer may
// install. Neither is re-implemented here — `apps/desktop/AGENTS.md` puts every
// refresh through that one scheduler, and a second latch is a review rejection.
//
// ONE ROUND FOR BOTH READS, WHICH IS WHY THE KEY IS SINGULAR. The policy and the
// partitions are two calls answering one question — what this node's browser settings
// are right now — so they are awaited together and installed together under a single
// latch key. Two keys would let a pass install half of itself: a policy answer from
// the round before a write beside a partition answer from the round after it, which is
// a screen no single moment ever looked like.
//
// AND AN ACT SUPERSEDES EVERY READ THAT STARTED BEFORE IT SETTLED, on both arms. A
// served write moved the record, so a read taken against the record before it is stale
// by construction; a refused write published a sentence the person is owed, and a read
// landing afterwards would erase it without replacing the information. Superseding
// costs nothing either way — nothing is cancelled, the reply simply installs nowhere —
// and the re-read that follows a served act is scheduled through the same scheduler,
// so it cannot overtake the read it superseded.
//
// AND AN ACT THAT ANSWERED NOTHING RECONCILES, WHICH IS A DIFFERENT ARM AGAIN. A call
// that REJECTED said nothing about what the node did: the clear may have run and lost
// its reply, the write may have been applied. Both used to end here with no re-read, so
// a removed partition could keep its byte figure on screen and a switch could keep
// drawing a position the record no longer holds, until a focus or reconnect happened by.
// So the dispositions part at the seam that already tells them apart: a refusal the node
// RETURNED is definite and re-reads nothing, a rejection is ambiguous and schedules
// reconciliation through this view's own scheduler. The classification is the SHAPE of
// the answer, never a reading of the thrown value — `core/wire-rejection.ts`' question.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import { Emitter, type Unsubscribe } from "../../core/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../store/index.js";
import {
  ambiguousPolicyWrite,
  declinedPolicyWrite,
  partitionListingFrom,
  partitionListingFromRejection,
  policyReadingFromRejection,
  policyReadingsFrom,
  refusedPartitionListing,
  refusedSwitchReading,
  SERVED_POLICY_WRITE,
  type BrowserPolicyReading,
  type PolicyWriteSettlement,
} from "./browser-settings-readings.js";
import type { BrowserPolicySwitchId, BrowserPolicySwitchReading } from "./policy-switches.js";
import type { BrowserPartitionListing } from "./site-partitions.js";
import type { SiteDataActOutcome } from "./site-data-clear.js";

/**
 * The one key both reads are taken under; an act supersedes whoever holds it.
 *
 * A console-local name and not a wire string: what it identifies is a round of this
 * page's reading, which nothing outside this module can name.
 */
const SETTINGS_READ_KEY = "browser-settings-read";

/** Everything the page renders from, in one value. */
export interface BrowserSettingsSnapshot {
  readonly policyReading: BrowserPolicyReading;
  readonly partitions: BrowserPartitionListing;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

/** Everything the page is handed: the two readings, and the two acts. */
export interface BrowserSettingsSource {
  readonly switchReadings: Readonly<Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>>;
  readonly toggleSwitch: (switchId: BrowserPolicySwitchId, nextEnabled: boolean) => void;
  readonly partitions: BrowserPartitionListing;
  readonly clearSiteData: (sessionId: string) => Promise<SiteDataActOutcome>;
}

const NOTHING_READ: BrowserSettingsSnapshot = {
  policyReading: { kind: "reading" },
  partitions: { kind: "reading" },
  revision: 0,
};

/**
 * The carrier: one scheduler, one latch key, two acts that supersede it.
 *
 * A CLASS RATHER THAN THREE PIECES OF COMPONENT STATE, on `apps/desktop/AGENTS.md`'s
 * rule and for its reason: the two readings and the round they belong to move
 * together, and separate cells updated in sequence is the same machine with its
 * illegal intermediate states reachable and unnamed.
 *
 * ONE INSTANCE PER BRIDGE. The hook below mints it keyed on the bridge, so a scenario
 * swap builds a new carrier and the previous one's replies install nowhere — the
 * property the subject-scoped holder gave this page before, obtained here from the
 * same identity comparison the latch already makes.
 */
export class BrowserSettingsView implements ReadTriggerTarget {
  /**
   * No session event refreshes these reads, and the empty set states it.
   *
   * Both answers are the NODE's rather than a session's, so nothing in any session's
   * timeline tells this reading that the node's policy or its stored bytes moved. The
   * window triggers are therefore the whole refresh story — which is why the read goes
   * through a scheduler rather than firing once at mount and never again.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;

  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<BrowserSettingsSnapshot>("browser settings change");
  readonly #reads = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #snapshot: BrowserSettingsSnapshot = NOTHING_READ;
  #hasStarted = false;
  #isDisposed = false;

  /**
   * Flip one switch, then re-read rather than patching a local copy.
   *
   * The node owns the record, and a page holding its own edited copy is a second
   * version of it nothing reconciles. An arrow field so the page's prop identity is
   * stable across renders without the mount composing a callback of its own.
   */
  public readonly toggleSwitch = (switchId: BrowserPolicySwitchId, nextEnabled: boolean): void => {
    void this.#write(switchId, nextEnabled);
  };

  /**
   * Clear one partition, then ask for a fresh listing.
   *
   * The re-read is the point of doing this here rather than at the button: a clear
   * that reported success and left the old byte figure on screen would be telling a
   * person their data is gone while showing them how much of it there is.
   *
   * A REJECTION IS NOT SWALLOWED HERE, and it is not left alone either.
   * `PartitionClearControl` knows which STEP it had reached and this carrier does not,
   * so the rejection is re-thrown verbatim rather than folded into a refusal whose
   * sentence could not name the step — but the node may have removed the partition and
   * lost the reply, so the listing is reconciled first: the re-read the control's own
   * words promise and nothing performed.
   */
  public readonly clearSiteData = async (sessionId: string): Promise<SiteDataActOutcome> => {
    const outcome = await this.#bridge.growth
      .browserSiteDataClear({ sessionId })
      .catch((rejection: unknown) => {
        this.#reconcileAfterAmbiguousAct();
        throw rejection;
      });
    if (outcome.status !== "served") {
      // Nothing moved, so nothing published and nothing superseded: the refusal is
      // this row's and the control renders it beside the row it was pressed on.
      return { status: "refused", refusal: outcome };
    }
    this.#supersedeReads();
    this.requestRead("user-request");
    return { status: "done" };
  };

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#scheduler = new RefreshScheduler({
      clock: consoleClockFor(bridge),
      perform: async () => {
        await this.#read();
      },
      // `#read` publishes the port's refusal itself and never rejects, so this arm is
      // for a defect in the publish rather than for anything about the wire — the
      // console's other readings carry it for the same reason.
      onError: () => undefined,
    });
  }

  public snapshot(): BrowserSettingsSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Read on mount. Idempotent: strict mode mounts an effect twice. */
  public start(): void {
    if (this.#hasStarted) {
      return;
    }
    this.#hasStarted = true;
    this.requestRead("subscribe");
  }

  /**
   * Ask for a read. The scheduler decides what a burst of these costs.
   *
   * `subscribe` at mount, `window-focus` on return, `reconnect` when the transport
   * came back, and `user-request` after an act this page performed — the four
   * reasons that reach a node-wide answer nothing events.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#reads.supersedeAll();
  }

  /**
   * One pass over both reads, installed together or not at all.
   *
   * Awaited as a pair rather than published as each arrives, so the screen is always
   * some single moment's answer. Neither half rejects — both settle their own refusal
   * — so `Promise.all` here loses nothing and is not a place a failure can hide.
   */
  async #read(): Promise<void> {
    const read = this.#reads.supersedeAndClaim(this, SETTINGS_READ_KEY);
    const [policyReading, partitions] = await Promise.all([
      this.#readPolicy(),
      this.#readPartitions(),
    ]);
    if (this.#isDisposed) {
      return;
    }
    read.settle(() => {
      this.#publish({ policyReading, partitions });
    });
    read.release();
  }

  async #readPolicy(): Promise<BrowserPolicyReading> {
    try {
      const outcome = await this.#bridge.growth.browserPolicyRead({});
      return outcome.status === "served"
        ? { kind: "read", values: outcome.value }
        : { kind: "refused", reading: refusedSwitchReading(outcome) };
    } catch (rejection: unknown) {
      return policyReadingFromRejection(rejection);
    }
  }

  async #readPartitions(): Promise<BrowserPartitionListing> {
    try {
      const outcome = await this.#bridge.growth.browserSiteDataList({});
      return outcome.status === "served"
        ? partitionListingFrom(outcome.value)
        : refusedPartitionListing(outcome);
    } catch (rejection: unknown) {
      return partitionListingFromRejection(rejection);
    }
  }

  /**
   * Write one switch and settle what the page says about it.
   *
   * SUPERSEDES ON BOTH ARMS, before anything is published. A served write moved the
   * record; a refused one published a sentence. Either way a read taken before this
   * settlement is answering a question that has since been re-asked, and installing it
   * would show a position nobody set or erase a refusal nobody read.
   */
  async #write(switchId: BrowserPolicySwitchId, nextEnabled: boolean): Promise<void> {
    const settlement = await this.#attemptWrite(switchId, nextEnabled);
    if (this.#isDisposed) {
      return;
    }
    this.#supersedeReads();
    if (settlement.kind === "served") {
      this.requestRead("user-request");
      return;
    }
    // Published FIRST on both failing arms, so the seam's own words are on screen while
    // the reconciliation below is still inside its window.
    this.#publish({ policyReading: settlement.reading });
    if (settlement.kind === "ambiguous") {
      this.requestRead("user-request");
    }
  }

  /** The write itself, as the disposition its answer earns. */
  async #attemptWrite(
    switchId: BrowserPolicySwitchId,
    nextEnabled: boolean,
  ): Promise<PolicyWriteSettlement> {
    try {
      const outcome = await this.#bridge.growth.browserPolicyWrite({
        switchId,
        enabled: nextEnabled,
      });
      return outcome.status === "served" ? SERVED_POLICY_WRITE : declinedPolicyWrite(outcome);
    } catch (rejection: unknown) {
      return ambiguousPolicyWrite(rejection);
    }
  }

  /**
   * An act answered nothing, so the node is asked what it holds now. Written once
   * because the halves are one move, and SCHEDULED rather than put: a person pressing
   * a control that keeps rejecting owes one reconciliation per burst.
   */
  #reconcileAfterAmbiguousAct(): void {
    if (this.#isDisposed) {
      return;
    }
    this.#supersedeReads();
    this.requestRead("user-request");
  }

  /**
   * Retire whatever read is in flight. Nothing is cancelled; it installs nowhere.
   *
   * `supersede` rather than a claim taken and dropped: this carrier is not starting a
   * round of its own here, it is ending the one that is running, and taking the key to
   * do it would leave the next read refused or the register holding a key nobody gives
   * back.
   */
  #supersedeReads(): void {
    this.#reads.supersede(this, SETTINGS_READ_KEY);
  }

  /**
   * Fold one transition in and hand out a new identity.
   *
   * The snapshot is HELD rather than composed on each read, because
   * `useSyncExternalStore` compares identity: a getter returning a fresh object on
   * every call renders forever.
   */
  #publish(changes: Partial<Omit<BrowserSettingsSnapshot, "revision">>): void {
    this.#snapshot = { ...this.#snapshot, ...changes, revision: this.#snapshot.revision + 1 };
    this.#changes.emit(this.#snapshot);
  }
}

/**
 * Bind the browser settings page's two reads to one bridge.
 *
 * Constructed in a memo and STARTED in an effect: building the carrier owns nothing —
 * no timer, no subscription, no call in flight — and the read is the side effect that
 * must not happen during render, so a memo React discards costs a discarded object and
 * no request.
 *
 * The WINDOW triggers only. This page holds no session, and its `triggeringEventKinds`
 * is empty, so the session half would have nothing to listen to.
 */
export function useBrowserSettingsSource(bridge: ConsoleBridge): BrowserSettingsSource {
  const view = useMemo(() => new BrowserSettingsView(bridge), [bridge]);
  useEffect(() => {
    view.start();
    return () => {
      view.dispose();
    };
  }, [view]);
  useWindowReadTriggers(view, bridge.transportReconnect);
  const snapshot = useSyncExternalStore(
    (onStoreChange: () => void) => view.subscribe(onStoreChange),
    () => view.snapshot(),
    () => view.snapshot(),
  );
  return useMemo(
    () => ({
      switchReadings: policyReadingsFrom(snapshot.policyReading),
      toggleSwitch: view.toggleSwitch,
      partitions: snapshot.partitions,
      clearSiteData: view.clearSiteData,
    }),
    [snapshot, view],
  );
}
