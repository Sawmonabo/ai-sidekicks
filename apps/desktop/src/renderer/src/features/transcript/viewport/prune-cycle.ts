// The window's cap cycle: one prune asked with every condition that can refuse it, and the
// re-ask a refusal owes.
//
// The state a re-ask needs (last conditions, outcome, held set) lives beside the pass that
// produces it, not among the controller's fields. The cycle asks the anchor for the floor, the
// held rows and whether a pin is gone, and notifies nobody, which keeps the controller's
// publication point single. It owns the compensation for pruned height because only the pass
// knows how many pixels it took; the controller decides when to pay it, after the row set is
// rebuilt, so a glide's geometry sample never wakes a subscriber against stale keys. The feed
// hands over the whole log on every pass, so the cap drops the same head rows again each time;
// the pass pays only for the rows that left the window it last published, and a remembered height
// outlives its row's prune, so a backward page that brings the row back lays it out at it.

import { IdleMemoryTrim } from "./idle-trim.js";
import { type ReadingAnchor } from "./reading-anchor.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type ViewportConditions } from "./snapshot.js";
import { type TranscriptRowVirtualizer } from "./virtualizer-options.js";
import {
  type TranscriptWindow,
  type PruneDeferralReason,
  type PruneOutcome,
} from "./window-cap.js";

/** Dependencies of a `ViewportPruneCycle`. */
export interface ViewportPruneCycleOptions {
  readonly window: TranscriptWindow;
  readonly measurements: RowMeasurementTable;
  readonly anchor: ReadingAnchor;
  readonly scroll: ScrollController;
  readonly clock: Clock;
  /** The virtualizer that laid the rows out, once it is bound. */
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
}

/** What one pass took, and the floor it was told to stop at. */
export interface ViewportPruneCycleResult {
  /**
   * The height the rows that left the published window were laid out at, summed in pixels;
   * zero while following, when no offset is held.
   */
  readonly prunedHeightPx: number;
  /** The row the drop may not walk past, or `undefined` while following. */
  readonly readingFloorRowKey: string | undefined;
}

/** Applies the window cap under every refusal condition and re-asks when a refusal lifts. */
export class ViewportPruneCycle {
  readonly #window: TranscriptWindow;
  readonly #measurements: RowMeasurementTable;
  readonly #anchor: ReadingAnchor;
  readonly #scroll: ScrollController;
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;
  /**
   * Owned here because `run` is called once per reconcile, the frame's signal that the
   * transcript moved; the trim measures quiet time against the clock.
   */
  readonly #idleTrim: IdleMemoryTrim;

  #lastOutcome: PruneOutcome | undefined;
  /**
   * The conditions the last pass folded in, kept so a deferred prune is re-asked with them; a
   * re-ask must not invent a row set nobody is showing.
   */
  #lastConditions: ViewportConditions | undefined;
  /**
   * The held set the last pass ran against. It is not on `ViewportConditions`, so `held-rows`
   * is answered by comparing it with the anchor's current one.
   */
  #lastHeldRowKeys: readonly string[] = [];

  public constructor(options: ViewportPruneCycleOptions) {
    this.#window = options.window;
    this.#measurements = options.measurements;
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#virtualizer = options.virtualizer;
    this.#idleTrim = new IdleMemoryTrim({
      clock: options.clock,
      window: options.window,
      measurements: options.measurements,
    });
  }

  /** What the last pass produced, or `undefined` before the first one. */
  public get lastOutcome(): PruneOutcome | undefined {
    return this.#lastOutcome;
  }

  /**
   * The row the prune may not walk past, or `undefined` while following, when the tail is the
   * position and the cap may take every row it allows.
   */
  public readingFloorRowKey(): string | undefined {
    const reading = this.#anchor.state;
    return reading.mode === "following" ? undefined : reading.anchorPoint?.rowKey;
  }

  /**
   * Ingests one render's rows, then applies the cap to the full set. The pruned height is summed
   * before the virtualizer re-renders, while it still lays out the rows that left.
   */
  public run(conditions: ViewportConditions): ViewportPruneCycleResult {
    // The transcript moved: if it was still for a dwell, the idle trim runs now.
    this.#idleTrim.noteActivity();
    this.#lastConditions = conditions;
    const readingFloorRowKey = this.readingFloorRowKey();
    const heldRowKeys = this.#anchor.heldRowKeys();
    this.#lastHeldRowKeys = heldRowKeys;
    this.#window.ingest(conditions.rows);
    const outcome = this.#window.prune({
      hasActiveTurn: conditions.hasActiveTurn,
      scrollControllerVetoes: this.#scroll.vetoesPrune(),
      revealDrainInFlight: conditions.isRevealDraining,
      pinnedRootCursor: this.#anchor.state.pinnedRootCursor,
      heldRowKeys,
      readingFloorRowKey,
    });
    this.#lastOutcome = outcome;
    const prunedHeightPx =
      readingFloorRowKey === undefined ? 0 : this.#laidOutHeightOf(outcome.newlyPrunedKeys);
    return { prunedHeightPx, readingFloorRowKey };
  }

  /**
   * Moves the offset up by exactly what the pass took from above the reader.
   *
   * Arithmetic, not an anchor glide: React has not re-rendered, so the virtualizer still answers
   * in pre-prune offsets, and the reading floor guarantees the dropped pixels sat above the
   * reader. Returns whether the offset moved, so the caller can fall back to the anchor glide.
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
   * A second entry point because a reader above the tail, a pin, a programmatic write and a held
   * row are facts about this frame that the feed's conditions do not carry; without it the window
   * stays over cap until the log changes. Reads `owedBecause`, not `deferredBecause`: a pass that
   * applied but stopped at the reading floor still over cap names no deferral. Answers
   * `undefined` cheaply and cannot spin while the blocker stands.
   */
  public owedConditions(): ViewportConditions | undefined {
    const conditions = this.#lastConditions;
    const owedBecause = this.#lastOutcome?.owedBecause;
    if (conditions === undefined || owedBecause === undefined) {
      return undefined;
    }
    return this.#deferralHasCleared(owedBecause) ? conditions : undefined;
  }

  /** Drops the hold on the last row set on teardown, so a disposed frame keeps nothing alive. */
  public forgetConditions(): void {
    this.#lastConditions = undefined;
    this.#lastHeldRowKeys = [];
  }

  /**
   * The height the virtualizer laid rows out at, summed: the size it holds for a row, else the
   * estimate it laid the row out at, which no publication moves while a reader holds a position.
   */
  #laidOutHeightOf(rowKeys: readonly string[]): number {
    const virtualizer = this.#virtualizer();
    let heightPx = 0;
    for (const rowKey of rowKeys) {
      heightPx += virtualizer?.itemSizeCache.get(rowKey) ?? this.#measurements.heightOf(rowKey);
    }
    return heightPx;
  }

  /**
   * Whether the condition that refused the last pass is gone. Total over
   * `PRUNE_DEFERRAL_REASONS`, so a new reason is a compile error until classified.
   *
   * `under-cap` owes nothing, and the feed already re-runs the pass when `active-turn` or
   * `reveal-drain` changes, so those answer `false`. `held-rows` compares the held set rather
   * than testing for empty: only a changed engagement helps a blocked walk, and comparing makes
   * the re-ask single-shot.
   */
  #deferralHasCleared(owedBecause: PruneDeferralReason): boolean {
    switch (owedBecause) {
      case "scroll-write":
        return !this.#scroll.vetoesPrune();
      case "pinned-history":
        return this.#anchor.state.pinnedRootCursor === undefined;
      case "reading-floor":
        return this.readingFloorRowKey() === undefined;
      case "held-rows":
        return !sameRowKeySet(this.#anchor.heldRowKeys(), this.#lastHeldRowKeys);
      case "under-cap":
      case "active-turn":
      case "reveal-drain":
        return false;
    }
  }
}

/**
 * Whether two held-row readings name the same rows, ignoring order: the walk reads the set
 * through a `Set`, so a reordering must not trigger a re-ask.
 */
function sameRowKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightKeys = new Set(right);
  return left.every((rowKey) => rightKeys.has(rowKey));
}
