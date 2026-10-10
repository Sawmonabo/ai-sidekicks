// Measurement table for the virtualizer, covering what `@tanstack/react-virtual` does not:
//   - Epsilon: the library compares sizes exactly, so a streaming row's sub-pixel wobble would
//     invalidate its cache every frame; `acceptedHeight` is what `measureElement` returns.
//   - Remembered heights: an accepted height is written to the session's one record of its row
//     heights, which outlives this mount, so a transcript mounted again lays its rows out at them.
//   - Estimates: a row with no height takes its kind's estimate. A row that reports its body's
//     length, of a kind whose measured rows fit a line of height on body length, is estimated on
//     that line; any other row at the median of its kind's newest measured rows or, before any,
//     at the kind's seed. An open call is estimated no taller than it draws with its output cut
//     at a share of the visible flow, and one whose output was opened whole no shorter. All three
//     move only when published. A row still revealing
//     its text joins its kind's samples once it settles, so its growth moves no estimate.
//   - Layout validity: a display or row width change re-lays out every row, so the heights and
//     the samples measured before it are dropped.
//   - Duplicate keys: its caches are keyed by item key, so two rows sharing one would displace
//     each other; a distinct virtual key per row keeps every row and counts the defect.

import { SCROLL_GEOMETRY_EPSILON_PX } from "#renderer/lib/scroll/geometry/sample.js";
import {
  RememberedRowHeights,
  type RowHeightDisplay,
} from "#renderer/store/session/remembered-row-heights.js";
import {
  ROW_HEIGHT_KINDS,
  ROW_HEIGHT_SEED_REM,
  cutCallHeightPx,
  type RowHeightKind,
} from "../rows/height-kind.js";

/** The keys the virtualizer is given, and what projecting them cost. */
export interface RowKeyProjection {
  /** One distinct key per row, index-aligned with the rows they came from. */
  readonly virtualKeys: readonly string[];
  /** Repeats seen in this pass. Non-zero is a projection defect, not a crash. */
  readonly duplicateKeyCount: number;
}

/**
 * Where a table's heights are kept, how it tells one row's kind and body length from another's,
 * and whom it tells of a height it accepted.
 */
export interface RowMeasurementTableOptions {
  /** The session's record of its row heights; a table given none keeps its own. */
  readonly rememberedHeights?: RememberedRowHeights | undefined;
  /**
   * The height kind the feed draws a row key as. A table given none knows no row's kind, and
   * estimates every row as the one-line notice of a row the window no longer holds.
   */
  readonly heightKindOf?: ((rowKey: string) => RowHeightKind) | undefined;
  /**
   * The UTF-8 byte length of the body a row key draws, or `undefined` for a row that reports
   * none. A table given none estimates every row at its kind's median or seed.
   */
  readonly bodyLengthOf?: ((rowKey: string) => number | undefined) | undefined;
  /** Called after each height the table accepts, synchronously, inside `acceptedHeight`. */
  readonly onHeightAccepted?: (() => void) | undefined;
  /**
   * The visible flow's height in pixels, whose share an open call's output is cut at, or
   * `undefined` before it is measured. A table given none caps no open call's estimate.
   */
  readonly viewportHeightPx?: (() => number | undefined) | undefined;
  /**
   * Whether a row is still revealing its text. Its heights are remembered but held out of its
   * kind's samples until it settles; a table given none samples every row as it is measured.
   */
  readonly isRowRevealing?: ((rowKey: string) => boolean) | undefined;
}

const EMPTY_PROJECTION: RowKeyProjection = { virtualKeys: [], duplicateKeyCount: 0 };

/**
 * How a repeat's projected key is spelled, declared once.
 *
 * Read back by {@link RowMeasurementTable.forgetAllExcept} and the kind lookup, which have to
 * recover the row a projected key was minted for. Two spellings of it would make the trim drop a
 * height for a row still on screen.
 */
const REPEAT_KEY_SEPARATOR = "~repeat-";

/**
 * The root font size a document has before any rule sets one, in pixels. Seeds are in rem, so
 * until the display is declared they are converted at this size.
 */
const INITIAL_ROOT_FONT_SIZE_PX = 16;

/**
 * Rows of one kind a median, or a line of height on body length, is taken over: the newest
 * thirty-one measured, about two screens of them. One unusually tall row moves the median by at
 * most one rank, and sorting or summing so few when the estimates are published costs nothing
 * measurable.
 */
const KIND_SAMPLE_SIZE = 31;

/**
 * Accepted row heights, the estimates for rows with none, and distinct keys for the virtualizer.
 */
export class RowMeasurementTable {
  readonly #rememberedHeights: RememberedRowHeights;
  readonly #heightKindOf: (rowKey: string) => RowHeightKind;
  readonly #bodyLengthOf: (rowKey: string) => number | undefined;
  readonly #onHeightAccepted: () => void;
  readonly #viewportHeightPx: () => number | undefined;
  readonly #isRowRevealing: (rowKey: string) => boolean;
  /** Every measured row of each kind, for its median and its smallest height. */
  readonly #heightSampleByKind: Readonly<Record<RowHeightKind, KindHeightSample>>;
  /** The measured rows of each kind that report a body length, for its line. */
  readonly #bodyLengthSampleByKind: Readonly<Record<RowHeightKind, KindHeightSample>>;
  /** What an unmeasured row of each kind is laid out at, in pixels, as last published. */
  readonly #estimatePxByKind: Record<RowHeightKind, number>;
  /** The line an unmeasured row reporting its body length is laid out on, as last published. */
  readonly #lineByKind: Record<RowHeightKind, BodyLengthLine | undefined>;
  /**
   * The height an open call is drawn at with its output cut, as last published, which bounds an
   * unmeasured open call's estimate; `undefined` while the viewport has no height.
   */
  #cutCallHeightPx: number | undefined;
  /**
   * The revealing rows measured since they last joined their kind's samples, each with the
   * height its samples hold for it, `undefined` for none.
   */
  readonly #sampledHeightOfHeldRow = new Map<string, number | undefined>();

  #cachedRowKeys: readonly string[] | undefined;
  #cachedProjection: RowKeyProjection = EMPTY_PROJECTION;

  public constructor(options: RowMeasurementTableOptions = {}) {
    this.#rememberedHeights = options.rememberedHeights ?? new RememberedRowHeights();
    this.#heightKindOf = options.heightKindOf ?? (() => "not-loaded");
    this.#bodyLengthOf = options.bodyLengthOf ?? (() => undefined);
    this.#onHeightAccepted = options.onHeightAccepted ?? (() => undefined);
    this.#viewportHeightPx = options.viewportHeightPx ?? (() => undefined);
    this.#isRowRevealing = options.isRowRevealing ?? (() => false);
    this.#heightSampleByKind = mapEveryKind(() => new KindHeightSample());
    this.#bodyLengthSampleByKind = mapEveryKind(() => new KindHeightSample());
    this.#estimatePxByKind = mapEveryKind((kind) => this.#seedPxOf(kind));
    this.#lineByKind = mapEveryKind(() => undefined);
  }

  /**
   * Declare the display the measurements are being taken on.
   *
   * Returns whether the layout the rows were placed with no longer holds (heights dropped, or the
   * seeds' pixel size moved), so the caller can tell the virtualizer to drop its own cache in the
   * same act: two caches disagreeing about a row's height is a scrollbar that never settles.
   */
  public setDisplaySettings(display: RowHeightDisplay): boolean {
    const previousRootFontSizePx = this.#rootFontSizePx();
    const isDropped = this.#rememberedHeights.declareDisplay(display);
    if (isDropped) {
      this.#clearSamples();
    }
    if (!isDropped && display.rootFontSizePx === previousRootFontSizePx) {
      return false;
    }
    this.publishEstimates();
    return true;
  }

  /** The width rows are laid out at, in pixels, as a row last declared it; `undefined` before. */
  public get rowWidthPx(): number | undefined {
    return this.#rememberedHeights.rowWidthPx;
  }

  /**
   * Declare the width rows are laid out at, in pixels, as a row's observation reported it. A new
   * width rewraps every row, so the remembered heights and the samples go; the published estimates
   * stay until the next publication.
   */
  public declareRowWidth(rowWidthPx: number): void {
    if (this.#rememberedHeights.declareRowWidth(rowWidthPx)) {
      this.#clearSamples();
    }
  }

  /**
   * The height the virtualizer should record for a row, given what was observed.
   *
   * A non-positive or non-finite observation is not a measurement (an unlaid-out element
   * reports zero, which would collapse the window), so the row's height or estimate stands. An
   * observation within the epsilon of the last one is the same height. Anything else is accepted,
   * remembered, replaces the row's last height in its kind's samples (once settled, for a row
   * still revealing), and is announced.
   */
  public acceptedHeight(rowKey: string, observedHeightPx: number): number {
    const previous = this.#rememberedHeights.heightOf(rowKey);
    if (!Number.isFinite(observedHeightPx) || observedHeightPx <= 0) {
      return previous ?? this.#estimateOf(rowKey);
    }
    if (
      previous !== undefined &&
      Math.abs(previous - observedHeightPx) < SCROLL_GEOMETRY_EPSILON_PX
    ) {
      return previous;
    }
    const accepted = this.#rememberedHeights.remember(rowKey, observedHeightPx);
    const sampledHeightPx = this.#sampledHeightOfHeldRow.has(rowKey)
      ? this.#sampledHeightOfHeldRow.get(rowKey)
      : previous;
    if (this.#isRowRevealing(this.#rowKeyOf(rowKey))) {
      this.#sampledHeightOfHeldRow.set(rowKey, sampledHeightPx);
    } else {
      this.#sampledHeightOfHeldRow.delete(rowKey);
      this.#sample(rowKey, sampledHeightPx, accepted);
    }
    this.#onHeightAccepted();
    return accepted;
  }

  /**
   * Moves every kind's estimate to the median of its sample, or to its seed while the sample is
   * empty, and its line to the least-squares fit of its measured rows' heights on their body
   * lengths. A line is kept only over at least two distinct lengths and a slope that is not
   * negative; otherwise the kind's rows take its median. An open call's estimate, on its line or
   * at its median, is capped at the height it draws with its output cut at the visible flow's
   * height as it stands now, and one whose output was opened whole is held to no less. A held row
   * that has settled since joins its samples first.
   *
   * Called only where a moved estimate cannot shift a row already laid out above the reader,
   * since the library reads an estimate whenever it re-lays a row out. Answers whether any
   * estimate moved by at least the geometry epsilon, a line's compared at the shortest and the
   * longest body length it was fitted over, so the caller re-lays out only for a real move.
   */
  public publishEstimates(): boolean {
    this.#sampleSettledRows();
    const previousCutCallHeightPx = this.#cutCallHeightPx;
    const viewportHeightPx = this.#viewportHeightPx();
    this.#cutCallHeightPx =
      viewportHeightPx === undefined || viewportHeightPx <= 0
        ? undefined
        : cutCallHeightPx(viewportHeightPx, this.#rootFontSizePx());
    let isMoved =
      this.#cutCallHeightPx === undefined || previousCutCallHeightPx === undefined
        ? this.#cutCallHeightPx !== previousCutCallHeightPx
        : Math.abs(this.#cutCallHeightPx - previousCutCallHeightPx) >= SCROLL_GEOMETRY_EPSILON_PX;
    for (const kind of ROW_HEIGHT_KINDS) {
      const previousEstimatePx = this.#estimatePxByKind[kind];
      const estimatePx = this.#heightSampleByKind[kind].median() ?? this.#seedPxOf(kind);
      this.#estimatePxByKind[kind] = estimatePx;
      const previousLine = this.#lineByKind[kind];
      const line = this.#bodyLengthSampleByKind[kind].bodyLengthLine(
        this.#heightSampleByKind[kind].smallestHeight(),
      );
      this.#lineByKind[kind] = line;
      isMoved ||=
        Math.abs(estimatePx - previousEstimatePx) >= SCROLL_GEOMETRY_EPSILON_PX ||
        hasLineMoved(previousLine, line);
    }
    return isMoved;
  }

  /**
   * Forgets every remembered height whose row is not in `retainedRowKeys`.
   *
   * Reaches a duplicate row measured under this module's private `~repeat-` key too. A height for
   * a retained row is never dropped, so nothing on screen is re-measured.
   */
  public forgetAllExcept(retainedRowKeys: readonly string[]): void {
    const retained = new Set(retainedRowKeys);
    this.#rememberedHeights.forgetAllExcept((measuredKey) =>
      retained.has(rowKeyOfMeasuredKey(measuredKey)),
    );
  }

  /** The height this table would report for a row: remembered, or its kind's estimate. */
  public heightOf(rowKey: string): number {
    return this.#rememberedHeights.heightOf(rowKey) ?? this.#estimateOf(rowKey);
  }

  /**
   * The height a row not yet in the feed's list would be laid out at, its kind and body length
   * told by the caller: the height the session remembers for its key, else the published
   * estimate for that kind and length.
   */
  public estimatedHeightOf(
    rowKey: string,
    kind: RowHeightKind,
    bodyLength: number | undefined,
  ): number {
    return this.#rememberedHeights.heightOf(rowKey) ?? this.#estimateFor(kind, bodyLength);
  }

  /**
   * The least height any drawn row is estimated at: every kind's published estimate and the floor
   * of its line. The line a row the window no longer holds draws is left out, since no row read
   * from the log is drawn as it.
   */
  public get smallestEstimatePx(): number {
    return Math.min(
      ...ROW_HEIGHT_KINDS.filter((kind) => kind !== "not-loaded").map((kind) =>
        this.#heldToCutPx(
          kind,
          Math.min(this.#estimatePxByKind[kind], this.#lineByKind[kind]?.floorPx ?? Infinity),
        ),
      ),
    );
  }

  /** The height the session measured a row at, or `undefined` when it remembers none. */
  public rememberedHeightOf(rowKey: string): number | undefined {
    return this.#rememberedHeights.heightOf(rowKey);
  }

  /**
   * Gives every row a distinct key and counts the repeats. Cached on the array's identity, so
   * callers should pass a memoized array; a rebuilt array pays the walk each time.
   */
  public projectKeys(rowKeys: readonly string[]): RowKeyProjection {
    if (this.#cachedRowKeys === rowKeys) {
      return this.#cachedProjection;
    }
    const seenKeys = new Set<string>();
    const virtualKeys: string[] = new Array<string>(rowKeys.length);
    let duplicateKeyCount = 0;
    for (let index = 0; index < rowKeys.length; index += 1) {
      const rowKey = rowKeys[index] ?? `row-without-a-key-${String(index)}`;
      if (seenKeys.has(rowKey)) {
        // A repeat is a different row with a taken name; a distinct virtual key keeps its own
        // measurement instead of displacing the first row's in the library's caches.
        duplicateKeyCount += 1;
        virtualKeys[index] = `${rowKey}${REPEAT_KEY_SEPARATOR}${String(duplicateKeyCount)}`;
        continue;
      }
      seenKeys.add(rowKey);
      virtualKeys[index] = rowKey;
    }
    this.#cachedRowKeys = rowKeys;
    this.#cachedProjection = { virtualKeys, duplicateKeyCount };
    return this.#cachedProjection;
  }

  #estimateOf(measuredKey: string): number {
    const kind = this.#kindOf(measuredKey);
    return this.#estimateFor(
      kind,
      this.#lineByKind[kind] === undefined
        ? undefined
        : this.#bodyLengthOf(this.#rowKeyOf(measuredKey)),
    );
  }

  /**
   * A kind's estimate: on its line where it has one and the length is known, else its median,
   * held to the cut height where the kind is bound to it.
   */
  #estimateFor(kind: RowHeightKind, bodyLength: number | undefined): number {
    const line = this.#lineByKind[kind];
    return this.#heldToCutPx(
      kind,
      line === undefined || bodyLength === undefined
        ? this.#estimatePxByKind[kind]
        : heightOnLine(line, bodyLength),
    );
  }

  /**
   * A kind's height held to the published cut height: an open call's no taller, one whose output
   * was opened whole no shorter, and any other kind's as it is.
   */
  #heldToCutPx(kind: RowHeightKind, heightPx: number): number {
    const cutPx = this.#cutCallHeightPx;
    if (cutPx === undefined) {
      return heightPx;
    }
    switch (kind) {
      case "tool-call-expanded":
        return Math.min(heightPx, cutPx);
      case "tool-call-output-opened":
        return Math.max(heightPx, cutPx);
      default:
        return heightPx;
    }
  }

  /** Replace a row's height in its kind's samples: `previousHeightPx` with `heightPx`. */
  #sample(measuredKey: string, previousHeightPx: number | undefined, heightPx: number): void {
    const kind = this.#kindOf(measuredKey);
    this.#heightSampleByKind[kind].replace(previousHeightPx, heightPx, Number.NaN);
    const bodyLength = this.#bodyLengthOf(this.#rowKeyOf(measuredKey));
    if (bodyLength !== undefined) {
      this.#bodyLengthSampleByKind[kind].replace(previousHeightPx, heightPx, bodyLength);
    }
  }

  /** Samples each held row that has stopped revealing, at the height last remembered for it. */
  #sampleSettledRows(): void {
    for (const [measuredKey, sampledHeightPx] of this.#sampledHeightOfHeldRow) {
      if (this.#isRowRevealing(this.#rowKeyOf(measuredKey))) {
        continue;
      }
      this.#sampledHeightOfHeldRow.delete(measuredKey);
      const heightPx = this.#rememberedHeights.heightOf(measuredKey);
      if (heightPx !== undefined) {
        this.#sample(measuredKey, sampledHeightPx, heightPx);
      }
    }
  }

  #kindOf(measuredKey: string): RowHeightKind {
    return this.#heightKindOf(this.#rowKeyOf(measuredKey));
  }

  /** The row a measured key names; a repeat's key is resolved only while one stands. */
  #rowKeyOf(measuredKey: string): string {
    return this.#cachedProjection.duplicateKeyCount === 0
      ? measuredKey
      : rowKeyOfMeasuredKey(measuredKey);
  }

  #seedPxOf(kind: RowHeightKind): number {
    return ROW_HEIGHT_SEED_REM[kind] * this.#rootFontSizePx();
  }

  #rootFontSizePx(): number {
    return this.#rememberedHeights.display?.rootFontSizePx ?? INITIAL_ROOT_FONT_SIZE_PX;
  }

  #clearSamples(): void {
    this.#sampledHeightOfHeldRow.clear();
    for (const kind of ROW_HEIGHT_KINDS) {
      this.#heightSampleByKind[kind].clear();
      this.#bodyLengthSampleByKind[kind].clear();
    }
  }
}

/** One value per height kind, built by `valueOf`. */
function mapEveryKind<TValue>(
  valueOf: (kind: RowHeightKind) => TValue,
): Record<RowHeightKind, TValue> {
  const valueByKind: Partial<Record<RowHeightKind, TValue>> = {};
  for (const kind of ROW_HEIGHT_KINDS) {
    valueByKind[kind] = valueOf(kind);
  }
  return valueByKind as Record<RowHeightKind, TValue>;
}

/**
 * The row a measured key was recorded under. The ordinal is checked, so a row whose own key
 * contains the separator is not truncated into a row that does not exist.
 */
function rowKeyOfMeasuredKey(measuredKey: string): string {
  const separatorIndex = measuredKey.lastIndexOf(REPEAT_KEY_SEPARATOR);
  if (separatorIndex < 0) {
    return measuredKey;
  }
  const ordinal = measuredKey.slice(separatorIndex + REPEAT_KEY_SEPARATOR.length);
  return ordinal.length > 0 && /^\d+$/.test(ordinal)
    ? measuredKey.slice(0, separatorIndex)
    : measuredKey;
}

/**
 * A kind's line of height on body length, as published: an unmeasured row reporting its length is
 * laid out on it, never below the floor.
 */
interface BodyLengthLine {
  readonly interceptPx: number;
  readonly slopePxPerByte: number;
  /** The smallest height the kind's sample held, which no estimate on the line goes below. */
  readonly floorPx: number;
  /** The shortest and longest body length the line was fitted over. */
  readonly shortestBodyLength: number;
  readonly longestBodyLength: number;
}

function heightOnLine(line: BodyLengthLine, bodyLength: number): number {
  return Math.max(line.floorPx, line.interceptPx + line.slopePxPerByte * bodyLength);
}

/**
 * Whether a newly fitted line lays rows out elsewhere than the last one: one of the two absent,
 * or a height at either end of the new line's lengths apart by at least the geometry epsilon.
 */
function hasLineMoved(
  previous: BodyLengthLine | undefined,
  next: BodyLengthLine | undefined,
): boolean {
  if (previous === undefined || next === undefined) {
    return previous !== next;
  }
  return [next.shortestBodyLength, next.longestBodyLength].some(
    (bodyLength) =>
      Math.abs(heightOnLine(next, bodyLength) - heightOnLine(previous, bodyLength)) >=
      SCROLL_GEOMETRY_EPSILON_PX,
  );
}

/**
 * The newest heights measured for one kind, each with its row's body length (`NaN` where the
 * sample does not keep one), each row once at its latest height: a re-measured row's new height
 * replaces its old one where the sample still holds it, so a reply streaming for a minute is one
 * entry rather than a thousand. Unkeyed, so it is no second record of a row.
 */
class KindHeightSample {
  readonly #heightsPx = new Float64Array(KIND_SAMPLE_SIZE);
  readonly #bodyLengths = new Float64Array(KIND_SAMPLE_SIZE);

  #count = 0;
  /** The slot the next height that replaces nothing is written to, the oldest once full. */
  #nextSlot = 0;

  /**
   * Record `heightPx` for a row whose body is `bodyLength` long, in place of the entry the sample
   * holds at `previousHeightPx` and the same length.
   */
  public replace(previousHeightPx: number | undefined, heightPx: number, bodyLength: number): void {
    if (previousHeightPx !== undefined) {
      for (let slot = 0; slot < this.#count; slot += 1) {
        if (
          this.#heightsPx[slot] === previousHeightPx &&
          Object.is(this.#bodyLengths[slot], bodyLength)
        ) {
          this.#heightsPx[slot] = heightPx;
          return;
        }
      }
    }
    this.#heightsPx[this.#nextSlot] = heightPx;
    this.#bodyLengths[this.#nextSlot] = bodyLength;
    this.#nextSlot = (this.#nextSlot + 1) % KIND_SAMPLE_SIZE;
    this.#count = Math.min(this.#count + 1, KIND_SAMPLE_SIZE);
  }

  /** The lower median of the sample, or `undefined` while it is empty. */
  public median(): number | undefined {
    if (this.#count === 0) {
      return undefined;
    }
    const sorted = this.#heightsPx.slice(0, this.#count).sort();
    return sorted[(this.#count - 1) >> 1];
  }

  /** The smallest height in the sample, or `Infinity` while it is empty. */
  public smallestHeight(): number {
    return Math.min(...this.#heightsPx.subarray(0, this.#count));
  }

  /**
   * The least-squares line of height on body length, floored at `floorPx`, or `undefined` unless
   * the sample holds at least two distinct lengths and the slope is not negative.
   */
  public bodyLengthLine(floorPx: number): BodyLengthLine | undefined {
    const bodyLengths = this.#bodyLengths.subarray(0, this.#count);
    const heightsPx = this.#heightsPx.subarray(0, this.#count);
    const shortestBodyLength = Math.min(...bodyLengths);
    const longestBodyLength = Math.max(...bodyLengths);
    if (!(longestBodyLength > shortestBodyLength)) {
      return undefined;
    }
    const meanBodyLength = mean(bodyLengths);
    const meanHeightPx = mean(heightsPx);
    let covariance = 0;
    let variance = 0;
    for (let slot = 0; slot < this.#count; slot += 1) {
      const lengthDeviation = (bodyLengths[slot] ?? 0) - meanBodyLength;
      covariance += lengthDeviation * ((heightsPx[slot] ?? 0) - meanHeightPx);
      variance += lengthDeviation * lengthDeviation;
    }
    const slopePxPerByte = covariance / variance;
    if (slopePxPerByte < 0) {
      return undefined;
    }
    return {
      interceptPx: meanHeightPx - slopePxPerByte * meanBodyLength,
      slopePxPerByte,
      floorPx,
      shortestBodyLength,
      longestBodyLength,
    };
  }

  public clear(): void {
    this.#count = 0;
    this.#nextSlot = 0;
  }
}

function mean(values: Float64Array): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
