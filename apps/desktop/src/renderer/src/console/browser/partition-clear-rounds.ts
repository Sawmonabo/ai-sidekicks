// Which partition has a clear running, held where the row it is drawn in cannot take
// it away.
//
// THE ACT WAS IDENTIFIED BY A COMPONENT INSTANCE, AND THE ROW IS NOT ONE. The table
// splits at `PARTITION_FOLD_THRESHOLD` into a shown list and a folded one, so a
// listing that refreshes while a clear is running can move that partition's row from
// the first `<ul>` to the second — a different parent element, which React reconciles
// as an unmount and a mount despite the `key`. The remounted control came up idle: the
// button was enabled again mid-clear, `aria-busy` was off, the stale projected refusal
// reappeared under an act that might be succeeding, a second confirm could start a
// second close underneath the first, and neither act's verdict was ever rendered,
// because both settlements wrote into a `useState` whose component was gone.
//
// SO THE ROUND OUTLIVES THE ROW, and this is where it lives: one object per mounted
// page, holding what each partition's clear is doing and the single-flight register
// that says whether another may start.
//
// THE SUBJECT IS THIS OBJECT, WHICH IS `generation-latch.ts`'s OWN "a holder that has
// no subject of its own and passes itself". The settings page is a projection: it
// performs no fetch, holds no store, and takes both acts as parameters, so it has no
// bridge to key a round on and taking one purely as an identity would be a prop
// nothing reads. What a round is actually about is this window's page and this
// partition — and this object IS the page's, replaced when the page is, which is what
// identity comparison expresses. The partition id is the key within it.
//
// REACT-FREE ON PURPOSE, like the substrate holder it borrows its rule from: every
// decision here is a property of an act starting and settling rather than of a render
// happening, so it is drivable with no renderer at all.

import { Emitter, type Unsubscribe } from "../core/index.js";
import { GenerationLatch, type GenerationClaim } from "../store/index.js";
import type { ClearSiteDataOutcome, ClearSiteDataStep } from "./site-data-clear.js";

/** One partition's clear, in the three phases it can be in. Declared once, here. */
export type PartitionClearState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly step: ClearSiteDataStep }
  | { readonly phase: "settled"; readonly outcome: ClearSiteDataOutcome };

/**
 * What a partition nobody has cleared reads as.
 *
 * One frozen value rather than a fresh literal per read: `useSyncExternalStore` calls
 * the snapshot on every render and compares the result, so a new object each time
 * would be a new value every pass and would loop the renderer.
 */
const IDLE_PARTITION_CLEAR: PartitionClearState = { phase: "idle" };

/**
 * Every clear this page has going, and the register that admits the next one.
 *
 * ONE INSTANCE PER MOUNTED PAGE. Its size is bounded by the partitions the node holds
 * — `SESSION_PARTITIONS_MAX` — and it holds nothing after the page is gone.
 */
export class PartitionClearRounds {
  readonly #latch = new GenerationLatch();
  readonly #statesByPartition = new Map<string, PartitionClearState>();
  readonly #changes = new Emitter<void>("partition clear round");

  /** What this partition's clear is doing. The snapshot a control renders. */
  public stateFor(sessionId: string): PartitionClearState {
    return this.#statesByPartition.get(sessionId) ?? IDLE_PARTITION_CLEAR;
  }

  /** Subscribe to every round's changes. Returns an idempotent unsubscribe. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Take this partition's slot and record the step the act starts on, or refuse.
   *
   * `undefined` rather than a claim that reports itself stale, so a caller cannot
   * dispatch first and discover afterwards that a clear was already running — which
   * is the second close underneath the first that the disabled button exists to
   * prevent, and which a control that had just been remounted could not otherwise see.
   */
  public begin(sessionId: string, step: ClearSiteDataStep): GenerationClaim | undefined {
    const round = this.#latch.claim(this, sessionId);
    if (round === undefined) {
      return undefined;
    }
    this.#write(sessionId, { phase: "running", step });
    return round;
  }

  /** Record a step this round has reached. A superseded round records nothing. */
  public reachStep(round: GenerationClaim, sessionId: string, step: ClearSiteDataStep): void {
    round.settle(() => {
      this.#write(sessionId, { phase: "running", step });
    });
  }

  /**
   * Record how this round ended and give the slot back.
   *
   * The release is unconditional and the write is not, which is the split
   * `generation-latch.ts` draws: a settlement from a round something else superseded
   * installs nowhere, while `release` is guarded inside the register and cannot free a
   * key its successor holds.
   */
  public settle(round: GenerationClaim, sessionId: string, outcome: ClearSiteDataOutcome): void {
    round.settle(() => {
      this.#write(sessionId, { phase: "settled", outcome });
    });
    round.release();
  }

  #write(sessionId: string, state: PartitionClearState): void {
    this.#statesByPartition.set(sessionId, state);
    this.#changes.emit();
  }
}
