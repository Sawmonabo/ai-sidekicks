// Measurement table for the virtualizer, covering what `@tanstack/react-virtual` does not:
//   - Epsilon: the library compares sizes exactly, so a streaming row's sub-pixel wobble would
//     invalidate its cache every frame; `acceptedHeight` is what `measureElement` returns.
//   - Remembered heights: an accepted height is written to the session's one record of its row
//     heights, which outlives this mount, so a transcript mounted again lays its rows out at them.
//   - Estimates: a row with no height takes its kind's estimate, the median of the kind's newest
//     measured rows or, before any, the kind's seed.
//   - Layout validity: a display or row width change re-lays out every row, so the heights and
//     the samples measured before it are dropped.
//   - Duplicate keys: its caches are keyed by item key, so two rows sharing one would displace
//     each other; a distinct virtual key per row keeps every row and counts the defect.

import { SCROLL_GEOMETRY_EPSILON_PX } from "#renderer/lib/scroll/geometry/sample.js";
import {
  RememberedRowHeights,
  type RowHeightDisplay,
} from "#renderer/store/session/remembered-row-heights.js";
import { ROW_HEIGHT_KINDS, ROW_HEIGHT_SEED_REM, type RowHeightKind } from "../rows/height-kind.js";

/** The keys the virtualizer is given, and what projecting them cost. */
export interface RowKeyProjection {
  /** One distinct key per row, index-aligned with the rows they came from. */
  readonly virtualKeys: readonly string[];
  /** Repeats seen in this pass. Non-zero is a projection defect, not a crash. */
  readonly duplicateKeyCount: number;
}

/** Where a table's heights are kept and how it tells one row's kind from another's. */
export interface RowMeasurementTableOptions {
  /** The session's record of its row heights; a table given none keeps its own. */
  readonly rememberedHeights?: RememberedRowHeights | undefined;
  /**
   * The height kind the feed draws a row key as. A table given none knows no row's kind, and
   * estimates every row as the one-line notice of a row the window no longer holds.
   */
  readonly heightKindOf?: ((rowKey: string) => RowHeightKind) | undefined;
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
 * Rows of one kind a median is taken over: the newest thirty-one measured, about two screens of
 * them. One unusually tall row moves the median by at most one rank, and sorting so few to read
 * it when the estimates are published costs nothing measurable.
 */
const KIND_SAMPLE_SIZE = 31;

/** Accepted row heights, the estimates for rows with none, and distinct keys for the virtualizer. */
export class RowMeasurementTable {
  readonly #rememberedHeights: RememberedRowHeights;
  readonly #heightKindOf: (rowKey: string) => RowHeightKind;
  readonly #sampleByKind: Readonly<Record<RowHeightKind, KindHeightSample>>;
  /** What an unmeasured row of each kind is laid out at, in pixels, as last published. */
  readonly #estimatePxByKind: Record<RowHeightKind, number>;

  #cachedRowKeys: readonly string[] | undefined;
  #cachedProjection: RowKeyProjection = EMPTY_PROJECTION;

  public constructor(options: RowMeasurementTableOptions = {}) {
    this.#rememberedHeights = options.rememberedHeights ?? new RememberedRowHeights();
    this.#heightKindOf = options.heightKindOf ?? (() => "not-loaded");
    this.#sampleByKind = mapEveryKind(() => new KindHeightSample());
    this.#estimatePxByKind = mapEveryKind((kind) => this.#seedPxOf(kind));
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
   * remembered, and replaces the row's last height in its kind's sample.
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
    this.#sampleByKind[this.#kindOf(rowKey)].replace(previous, accepted);
    return accepted;
  }

  /**
   * Moves every kind's estimate to the median of its sample, or to its seed while the sample is
   * empty. Called only where a moved estimate cannot shift a row already laid out above the
   * reader, since the library reads an estimate whenever it re-lays a row out.
   */
  public publishEstimates(): void {
    for (const kind of ROW_HEIGHT_KINDS) {
      this.#estimatePxByKind[kind] = this.#sampleByKind[kind].median() ?? this.#seedPxOf(kind);
    }
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
    return this.#estimatePxByKind[this.#kindOf(measuredKey)];
  }

  /** The kind of the row a measured key names; a repeat's key is resolved only while one stands. */
  #kindOf(measuredKey: string): RowHeightKind {
    return this.#heightKindOf(
      this.#cachedProjection.duplicateKeyCount === 0
        ? measuredKey
        : rowKeyOfMeasuredKey(measuredKey),
    );
  }

  #seedPxOf(kind: RowHeightKind): number {
    return ROW_HEIGHT_SEED_REM[kind] * this.#rootFontSizePx();
  }

  #rootFontSizePx(): number {
    return this.#rememberedHeights.display?.rootFontSizePx ?? INITIAL_ROOT_FONT_SIZE_PX;
  }

  #clearSamples(): void {
    for (const kind of ROW_HEIGHT_KINDS) {
      this.#sampleByKind[kind].clear();
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
 * The newest heights measured for one kind, each row once at its latest height: a re-measured
 * row's new height replaces its old one where the sample still holds it, so a reply streaming for
 * a minute is one sample rather than a thousand. Unkeyed, so it is no second record of a row.
 */
class KindHeightSample {
  readonly #heightsPx = new Float64Array(KIND_SAMPLE_SIZE);

  #count = 0;
  /** The slot the next height that replaces nothing is written to, the oldest once full. */
  #nextSlot = 0;

  /** Record `heightPx`, in place of `previousHeightPx` where the sample holds it. */
  public replace(previousHeightPx: number | undefined, heightPx: number): void {
    if (previousHeightPx !== undefined) {
      const slot = this.#heightsPx.subarray(0, this.#count).indexOf(previousHeightPx);
      if (slot >= 0) {
        this.#heightsPx[slot] = heightPx;
        return;
      }
    }
    this.#heightsPx[this.#nextSlot] = heightPx;
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

  public clear(): void {
    this.#count = 0;
    this.#nextSlot = 0;
  }
}
