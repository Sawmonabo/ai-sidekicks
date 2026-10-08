// The window's cycle: one pass asked with the reading position, the viewport's height and every
// condition that can refuse a cut, the stretch a reader's approach to an edge is owed (from the
// log, or from the daemon's history once the window holds that edge of the log), and the re-ask a
// refusal owes.
//
// The state a re-ask needs (last conditions, outcome, held and on-screen sets) lives beside the
// pass that produces it, not among the controller's fields. The cycle reads the anchor and the
// virtualizer and notifies nobody, which keeps the controller's publication point single. It owns
// the compensation for the height let go above the reader because only the pass knows which rows
// went; the controller pays it after the row set is rebuilt, so a glide's geometry sample never
// wakes a subscriber against stale keys. Every height is read as the virtualizer laid the row
// out, so the pass and the scroll offset agree about where each edge of the window sits.

import { type Clock } from "#renderer/lib/clock.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollGeometry } from "#renderer/lib/scroll/geometry/sample.js";
import {
  TRANSCRIPT_APPROACH_SCREEN_HEIGHTS,
  TRANSCRIPT_GESTURE_GAP_MS,
  TRANSCRIPT_LET_GO_SCREEN_HEIGHTS,
} from "./caps.js";
import { IdleMemoryTrim } from "./idle-trim.js";
import { type ReadingAnchor, type ReadingAnchorPoint } from "./reading-anchor.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type ViewportConditions } from "./snapshot.js";
import { type TranscriptRowVirtualizer } from "./virtualizer-options.js";
import {
  type PruneDeferralReason,
  type PruneOutcome,
  type TranscriptWindow,
  type WindowSide,
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
  /** The keys the viewport last published, in the order the virtualizer laid them out. */
  readonly publishedRowKeys: () => readonly string[];
  /** A published key's index in that order, or `undefined` for a key it does not hold. */
  readonly publishedIndexOf: (rowKey: string) => number | undefined;
  /** Asks the history reader for the stretch past an edge of the log, as the controller is told. */
  readonly readBeyondLogEdge: ((side: WindowSide) => boolean) | undefined;
}

/** What one pass took, for the controller to pay. */
export interface ViewportPruneCycleResult {
  /**
   * The height the rows let go above the reader were laid out at, summed in pixels; zero while
   * following, when the virtualizer's end anchor holds the position.
   */
  readonly prunedHeightPx: number;
  /** Whether the reader followed the tail during the pass. */
  readonly isFollowing: boolean;
}

/** A pass a reader's scroll sample asks for, and the side a stretch is admitted on, if any. */
export interface WindowPassRequest {
  readonly admitSide: WindowSide | undefined;
}

/** Runs the window under every refusal condition, admits on approach, and re-asks a refusal. */
export class ViewportPruneCycle {
  readonly #window: TranscriptWindow;
  readonly #measurements: RowMeasurementTable;
  readonly #anchor: ReadingAnchor;
  readonly #scroll: ScrollController;
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;
  readonly #publishedRowKeys: () => readonly string[];
  readonly #publishedIndexOf: (rowKey: string) => number | undefined;
  readonly #readBeyondLogEdge: ((side: WindowSide) => boolean) | undefined;
  readonly #clock: Clock;
  /**
   * Owned here because `run` is called once per pass, the frame's signal that the transcript
   * moved; the trim measures quiet time against the clock.
   */
  readonly #idleTrim: IdleMemoryTrim;

  #lastOutcome: PruneOutcome | undefined;
  /**
   * The conditions the last pass folded in, kept so a deferred pass or a reader's approach is
   * run with them; a re-ask must not invent a row set nobody is showing.
   */
  #lastConditions: ViewportConditions | undefined;
  /** The held set the last pass ran against; `held-rows` clears when it changes. */
  #lastHeldRowKeys: readonly string[] = [];
  /** The rows on screen when the last pass ran; `on-screen-rows` clears when they change. */
  #lastOnScreenRowKeys: readonly string[] = [];
  /** The reader's row when the last pass ran; `reading-floor` clears when it changes. */
  #lastReadingRowKey: string | undefined;
  /** The last sample heard, of any cause, so an edge crossing the let-go distance is told apart. */
  #lastSample: ScrollGeometry | undefined;
  /** The clock stamp of the reader's last scroll sample or pull, which a pause measures from. */
  #lastReaderSampleAtMs: number | undefined;
  /** Whether the reader's current gesture has had its stretch. */
  #hasGestureAdmitted = false;

  public constructor(options: ViewportPruneCycleOptions) {
    this.#window = options.window;
    this.#measurements = options.measurements;
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#virtualizer = options.virtualizer;
    this.#publishedRowKeys = options.publishedRowKeys;
    this.#publishedIndexOf = options.publishedIndexOf;
    this.#readBeyondLogEdge = options.readBeyondLogEdge;
    this.#clock = options.clock;
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

  /** The conditions the last pass ran with, which a pass the feed did not ask for runs again. */
  public get lastConditions(): ViewportConditions | undefined {
    return this.#lastConditions;
  }

  /**
   * Ingests one render's rows, then admits and lets go around the reading position. The height
   * let go is summed before the virtualizer re-renders, while it still lays out the rows that left.
   */
  public run(conditions: ViewportConditions, admitSide?: WindowSide): ViewportPruneCycleResult {
    // The transcript moved: if it was still for a dwell, the idle trim runs now.
    this.#idleTrim.noteActivity();
    this.#lastConditions = conditions;
    const readingPosition = this.#readingPosition();
    const heldRowKeys = this.#anchor.heldRowKeys();
    const onScreenRowKeys = this.#onScreenRowKeys();
    this.#lastHeldRowKeys = heldRowKeys;
    this.#lastOnScreenRowKeys = onScreenRowKeys;
    this.#lastReadingRowKey = readingPositionRowKey(readingPosition);
    // Rebuilds the library's measurement memo when a row measured since it was last read, so the
    // sizes read below are the ones the offset was laid out with.
    this.#virtualizer()?.getTotalSize();
    this.#window.ingest(conditions.rows);
    const outcome = this.#window.prune({
      scrollControllerVetoes: this.#scroll.vetoesPrune(),
      liveRunGroupKeys: conditions.liveRunGroupKeys,
      heldRowKeys,
      onScreenRowKeys,
      readingPosition,
      viewportHeightPx: this.#scroll.geometry?.viewportHeight,
      heightOf: (rowKey) => this.#laidOutHeightOf(rowKey),
      admitSide,
    });
    this.#lastOutcome = outcome;
    const isFollowing = readingPosition === "tail";
    const prunedHeightPx = isFollowing
      ? 0
      : outcome.prunedAboveKeys.reduce(
          (heightPx, rowKey) => heightPx + this.#laidOutHeightOf(rowKey),
          0,
        );
    return { prunedHeightPx, isFollowing };
  }

  /**
   * Moves the offset up by exactly what the pass let go above the reader.
   *
   * Arithmetic, not an anchor glide: React has not re-rendered, so the virtualizer still answers
   * in pre-cut offsets, and the cut stops short of the reader's row, so the pixels it took sat
   * above them. Returns whether the offset moved, so the caller can fall back to the anchor glide.
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
   * The pass a geometry sample asks for, or `undefined` when it asks for none: a stretch when the
   * reader comes within the approach distance of an edge the log holds rows past, once per
   * gesture, or a cut when an edge has just drifted past the let-go distance. At an edge the
   * window holds of the log, the gesture's stretch is asked of the history reader instead.
   *
   * Only the reader's own scroll asks; a sample a programmatic write published is the transcript
   * moving itself. A gesture ends at a pause of `TRANSCRIPT_GESTURE_GAP_MS` between the reader's
   * samples, read off their clock stamps, so a fling brings one stretch and arms no timer.
   */
  public passOwedBy(geometry: ScrollGeometry): WindowPassRequest | undefined {
    const previous = this.#lastSample;
    this.#lastSample = geometry;
    const screenHeightPx = geometry.viewportHeight;
    if (
      this.#lastConditions === undefined ||
      screenHeightPx <= 0 ||
      geometry.cause !== "scroll" ||
      this.#scroll.vetoesPrune()
    ) {
      return undefined;
    }
    this.#noteReaderInputAt(geometry.sampledAt);
    const approachPx = TRANSCRIPT_APPROACH_SCREEN_HEIGHTS * screenHeightPx;
    const isNearHead = geometry.scrollTop < approachPx;
    const isNearTail = geometry.distanceFromTailPx < approachPx;
    const admitSide: WindowSide | undefined =
      isNearHead && !this.#window.holdsLogHead
        ? "head"
        : isNearTail && !this.#window.holdsLogTail
          ? "tail"
          : undefined;
    if (!this.#hasGestureAdmitted) {
      if (admitSide !== undefined) {
        this.#hasGestureAdmitted = true;
        return { admitSide };
      }
      if ((isNearHead && this.#readsBeyond("head")) || (isNearTail && this.#readsBeyond("tail"))) {
        this.#hasGestureAdmitted = true;
        return undefined;
      }
    }
    // Asked as the edge crosses the distance rather than on every sample past it, so a pass that
    // found nothing to let go is not run again for each pixel scrolled.
    const letGoPx = TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * screenHeightPx;
    const hasCrossed = (distancePx: number, previousDistancePx: number | undefined): boolean =>
      distancePx > letGoPx && (previousDistancePx === undefined || previousDistancePx <= letGoPx);
    return hasCrossed(geometry.scrollTop, previous?.scrollTop) ||
      hasCrossed(geometry.distanceFromTailPx, previous?.distanceFromTailPx)
      ? { admitSide: undefined }
      : undefined;
  }

  /**
   * The pass a pull past one end owes with the reader already at that end, where the box cannot
   * scroll and publishes no sample: a wheel, an arrow key or a drag. The same one stretch per
   * gesture as an approach, from the log when the window has let that edge go, else from the
   * history reader.
   */
  public passOwedByPullAt(side: WindowSide): WindowPassRequest | undefined {
    if (this.#lastConditions === undefined || this.#scroll.vetoesPrune()) {
      return undefined;
    }
    this.#noteReaderInputAt(this.#clock.now());
    if (this.#hasGestureAdmitted) {
      return undefined;
    }
    const holdsLogEdge = side === "head" ? this.#window.holdsLogHead : this.#window.holdsLogTail;
    if (!holdsLogEdge) {
      this.#hasGestureAdmitted = true;
      return { admitSide: side };
    }
    this.#hasGestureAdmitted = this.#readsBeyond(side);
    return undefined;
  }

  /**
   * The conditions a re-ask is owed with, or `undefined` when nothing is owed.
   *
   * A second entry point because a reader's place, a programmatic write, the rows on screen and a
   * held row are facts about this frame that the feed's conditions do not carry; without it the
   * window stays past its share until the log changes. Reads `owedBecause`, not `deferredBecause`:
   * a cut that stopped short applied yet still owes. Answers `undefined` cheaply and cannot spin
   * while the blocker stands.
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
    this.#lastOnScreenRowKeys = [];
  }

  /** Starts a new gesture when the reader's input comes a gesture gap after their last one. */
  #noteReaderInputAt(inputAtMs: number): void {
    const lastReaderSampleAtMs = this.#lastReaderSampleAtMs;
    this.#lastReaderSampleAtMs = inputAtMs;
    if (
      lastReaderSampleAtMs === undefined ||
      inputAtMs - lastReaderSampleAtMs >= TRANSCRIPT_GESTURE_GAP_MS
    ) {
      this.#hasGestureAdmitted = false;
    }
  }

  /** Whether the history reader took the stretch past this edge of the log as the gesture's. */
  #readsBeyond(side: WindowSide): boolean {
    return this.#readBeyondLogEdge?.(side) ?? false;
  }

  /** The reader's place: the tail while following, their anchored row otherwise. */
  #readingPosition(): ReadingAnchorPoint | "tail" | undefined {
    const reading = this.#anchor.state;
    return reading.mode === "following" ? "tail" : reading.anchorPoint;
  }

  /** The keys of the rows the virtualizer has on screen, without its drawn band. */
  #onScreenRowKeys(): readonly string[] {
    const range = this.#virtualizer()?.range;
    return range === undefined || range === null
      ? []
      : this.#publishedRowKeys().slice(range.startIndex, range.endIndex + 1);
  }

  /**
   * The height the virtualizer laid a row out at: its laid-out size where the published window
   * holds the row, the size it holds for the key, else the estimate it would lay the row out at.
   */
  #laidOutHeightOf(rowKey: string): number {
    const virtualizer = this.#virtualizer();
    const publishedIndex = this.#publishedIndexOf(rowKey);
    const laidOutSizePx =
      publishedIndex === undefined
        ? undefined
        : virtualizer?.measurementsCache[publishedIndex]?.size;
    return (
      laidOutSizePx ?? virtualizer?.itemSizeCache.get(rowKey) ?? this.#measurements.heightOf(rowKey)
    );
  }

  /**
   * Whether the condition that refused the last pass is gone. Total over
   * `PRUNE_DEFERRAL_REASONS`, so a new reason is a compile error until classified.
   *
   * `within-share` owes nothing, and the feed already re-runs the pass when a run ends, which is
   * when `live-run-group` clears, so those answer `false`. The sets compare rather than test for empty:
   * only a changed engagement, screen or place helps a stopped cut, and comparing makes the
   * re-ask single-shot.
   */
  #deferralHasCleared(owedBecause: PruneDeferralReason): boolean {
    switch (owedBecause) {
      case "unmeasured": {
        // The window's own test: a height, and a reading position the log holds. A reader on a
        // row folded out of the log stays unplaced, so asking again would refuse again.
        const readingPosition = this.#readingPosition();
        return (
          (this.#scroll.geometry?.viewportHeight ?? 0) > 0 &&
          (readingPosition === "tail" ||
            (readingPosition !== undefined && this.#window.logHoldsRow(readingPosition.rowKey)))
        );
      }
      case "scroll-write":
        return !this.#scroll.vetoesPrune();
      case "reading-floor":
        return readingPositionRowKey(this.#readingPosition()) !== this.#lastReadingRowKey;
      case "on-screen-rows":
        return !sameRowKeySet(this.#onScreenRowKeys(), this.#lastOnScreenRowKeys);
      case "held-rows":
        return !sameRowKeySet(this.#anchor.heldRowKeys(), this.#lastHeldRowKeys);
      case "within-share":
      case "live-run-group":
        return false;
    }
  }
}

/** The row a reading position names, or `undefined` for the tail or an unplaced reader. */
function readingPositionRowKey(
  readingPosition: ReadingAnchorPoint | "tail" | undefined,
): string | undefined {
  return readingPosition === undefined || readingPosition === "tail"
    ? undefined
    : readingPosition.rowKey;
}

/**
 * Whether two readings of row keys name the same rows, ignoring order: the pass reads each set
 * through a `Set`, so a reordering must not trigger a re-ask.
 */
function sameRowKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightKeys = new Set(right);
  return left.every((rowKey) => rightKeys.has(rowKey));
}
