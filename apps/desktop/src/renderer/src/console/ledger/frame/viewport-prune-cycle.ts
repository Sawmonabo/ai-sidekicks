// The ledger window's cap cycle: one prune, asked with every condition that can
// refuse it, and the re-ask a refusal owes.
//
// WHY THIS IS ITS OWN OBJECT. `viewport-controller.ts` is the wiring — it owns the
// four objects, decides when each is asked anything, and tells the tree what
// changed. Applying the cap is a different job with its own state: the conditions
// the last pass was asked with, the outcome it produced, and the rule that says
// whether a refusal has since lifted. That state is read by nothing else and is
// exactly what a re-ask must not invent, so it lives beside the pass that produces
// it rather than among the controller's fields.
//
// WHAT IT DOES NOT DECIDE. Not which rows exist — the window holds those, and the
// controller reads them back after a pass. Not where the reader is — the anchor
// decides that, and this object only ASKS it, twice: once for the floor the drop
// may not walk past, and once to see whether a pin it was refused for is gone. And
// not what the tree is told: a pass changes the window and this object notifies
// nobody, which is what keeps the controller's single publication point single.
//
// THE COMPENSATION IS HERE BECAUSE THE CYCLE IS WHAT INCURRED IT. Dropping rows
// above the fold moves every offset below them, and the number of pixels owed is
// known only to the pass that took them. The controller decides WHEN to pay it —
// after the row set it holds has been rebuilt, so a glide's own geometry sample
// never wakes a subscriber against a stale key list.
//
// Its cases are `viewport-controller.test.ts`': the cycle is driven through
// `reconcile` and `retryDeferredPrune` and through nothing else, so driving it
// apart from the controller would be driving a stand-in for the caller.

import { type ReadingAnchor } from "./reading-anchor.js";
import { type RowMeasurementLedger } from "./row-measurement-ledger.js";
import { type LedgerScrollController } from "./scroll-chokepoint.js";
import { type LedgerViewportConditions } from "./viewport-snapshot.js";
import { type LedgerWindow, type PruneDeferralReason, type PruneOutcome } from "./window-cap.js";

export interface LedgerPruneCycleOptions {
  readonly window: LedgerWindow;
  readonly measurements: RowMeasurementLedger;
  readonly anchor: ReadingAnchor;
  readonly scroll: LedgerScrollController;
}

/** What one pass took, and the floor it was told to stop at. */
export interface LedgerPruneCycleResult {
  /** Measured height of every row the pass dropped, summed in pixels. */
  readonly prunedHeightPx: number;
  /** The row the drop may not walk past, or `undefined` while following. */
  readonly readingFloorRowKey: string | undefined;
}

export class LedgerPruneCycle {
  readonly #window: LedgerWindow;
  readonly #measurements: RowMeasurementLedger;
  readonly #anchor: ReadingAnchor;
  readonly #scroll: LedgerScrollController;

  #lastOutcome: PruneOutcome | undefined;
  /**
   * The conditions the last pass folded in, kept so a deferred prune can be
   * re-asked with them.
   *
   * The surrounding surface reports these on a render, and the three of them are
   * exactly what a re-ask must NOT invent: re-running the prune against a row set
   * this frame made up would apply the cap to a window nobody is showing.
   */
  #lastConditions: LedgerViewportConditions | undefined;

  public constructor(options: LedgerPruneCycleOptions) {
    this.#window = options.window;
    this.#measurements = options.measurements;
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
  }

  /** What the last pass produced, or `undefined` before the first one. */
  public get lastOutcome(): PruneOutcome | undefined {
    return this.#lastOutcome;
  }

  /**
   * The row the prune may not walk past, or `undefined` while following — where
   * the tail IS the position and the frame glides back to it, so the window is
   * free to take every row the cap allows.
   */
  public readingFloorRowKey(): string | undefined {
    const reading = this.#anchor.state;
    return reading.mode === "following" ? undefined : reading.anchorPoint?.rowKey;
  }

  /**
   * Take one render's rows and apply the cap to them.
   *
   * Order matters. Ingest first so the window knows about every row; prune second
   * so the cap is applied to the full set. The pruned height is summed BEFORE the
   * priors are dropped: after the loop below there is nothing left to ask how tall
   * the pruned rows were.
   */
  public run(conditions: LedgerViewportConditions): LedgerPruneCycleResult {
    this.#lastConditions = conditions;
    const readingFloorRowKey = this.readingFloorRowKey();
    this.#window.ingest(conditions.rows);
    const outcome = this.#window.prune({
      hasActiveTurn: conditions.hasActiveTurn,
      scrollControllerVetoes: this.#scroll.vetoesPrune(),
      revealDrainInFlight: conditions.isRevealDraining,
      pinnedRootCursor: this.#anchor.state.pinnedRootCursor,
      heldRowKeys: this.#anchor.heldRowKeys(),
      readingFloorRowKey,
    });
    this.#lastOutcome = outcome;
    const prunedHeightPx = outcome.prunedKeys.reduce(
      (heightPx, prunedKey) => heightPx + this.#measurements.heightOf(prunedKey),
      0,
    );
    for (const prunedKey of outcome.prunedKeys) {
      this.#measurements.forget(prunedKey);
    }
    return { prunedHeightPx, readingFloorRowKey };
  }

  /**
   * Move the offset up by exactly what the pass took from above the reader.
   *
   * Arithmetic rather than a second anchor glide: React has not re-rendered yet, so
   * the virtualizer still answers in the pre-prune offset space. What was dropped is
   * known exactly and the reading floor guarantees every pixel of it sat above the
   * reader, so subtracting the sum leaves their row under the same pixel with no
   * measurement read at all. Returns whether the offset moved, so the caller can
   * fall back to the anchor glide when there was nothing or nowhere to compensate.
   */
  public compensateForPrunedHeight(prunedHeightPx: number): boolean {
    const currentScrollTopPx = this.#scroll.geometry?.scrollTop;
    if (prunedHeightPx <= 0 || currentScrollTopPx === undefined) {
      return false;
    }
    return (
      this.#scroll.glideTo("prune-compensation", currentScrollTopPx - prunedHeightPx) !== undefined
    );
  }

  /**
   * The conditions a re-ask is owed with, or `undefined` when nothing is owed.
   *
   * WHY A SECOND ENTRY POINT AND NOT A WIDER RECONCILE. A pass is driven by the
   * three conditions the surrounding surface reports — the row set, the turn
   * activity, the reveal drain — and three of the six refusals below are conditions
   * NONE of those three carry: a reader above the tail, a pin, and a programmatic
   * write in flight are facts about this frame. A window left over its cap by one of
   * them therefore stayed over cap until the log happened to change, which on an
   * idle session is never — the reader came back to the tail and the rows the cap
   * had already refused to take stayed in memory indefinitely.
   *
   * Answers `undefined` cheaply when nothing is owed: a window whose last pass
   * applied, or was refused for a reason still true, reports nothing — which is what
   * lets the binding ask on a reading transition without checking anything first.
   */
  public owedConditions(): LedgerViewportConditions | undefined {
    const conditions = this.#lastConditions;
    const deferredBecause = this.#lastOutcome?.deferredBecause;
    if (conditions === undefined || deferredBecause === undefined) {
      return undefined;
    }
    return this.#deferralHasCleared(deferredBecause) ? conditions : undefined;
  }

  /**
   * Drop the hold on the last row set.
   *
   * Called from the controller's teardown: a disposed frame that kept it would hold
   * a whole window's identity list alive for as long as anything still referenced
   * the corpse.
   */
  public forgetConditions(): void {
    this.#lastConditions = undefined;
  }

  /**
   * Whether the condition that refused the last pass is gone.
   *
   * TOTAL over `PRUNE_DEFERRAL_REASONS`, so a reason `window-cap.ts` registers is a
   * compile error here until it is classified — which is the point: the failure this
   * method exists to prevent is a refusal nobody re-asks about, and a new refusal
   * that silently fell through to "never retry" would be exactly that failure again.
   *
   * THE THREE ARMS THAT ANSWER `false` ARE NOT UNOBSERVABLE, THEY ARE ALREADY
   * OBSERVED. `under-cap` is not a refusal to retry at all — the window is within
   * its cap and there is nothing owed. `active-turn` and `reveal-drain` are read
   * straight off `LedgerViewportConditions`, so the surface that reports them
   * re-runs the pass the moment either changes; retrying them here would be a
   * second reader of one fact, racing the first.
   */
  #deferralHasCleared(deferredBecause: PruneDeferralReason): boolean {
    switch (deferredBecause) {
      case "scroll-write":
        return !this.#scroll.vetoesPrune();
      case "pinned-history":
        return this.#anchor.state.pinnedRootCursor === undefined;
      case "reading-floor":
        return this.readingFloorRowKey() === undefined;
      case "under-cap":
      case "active-turn":
      case "reveal-drain":
        return false;
    }
  }
}
