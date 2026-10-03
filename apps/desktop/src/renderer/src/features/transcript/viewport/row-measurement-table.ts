// Measurement table for the virtualizer, covering what `@tanstack/react-virtual` does not:
//   - Epsilon: the library compares sizes exactly, so a streaming row's sub-pixel wobble would
//     invalidate its cache every frame; `acceptedHeight` is what `measureElement` returns.
//   - A prior ceiling: its `itemSizeCache` never evicts; this table's priors are bounded,
//     oldest first.
//   - Display validity: a device-pixel-ratio or root-font-size change re-lays out every row.
//   - Duplicate keys: its caches are keyed by item key, so two rows sharing one would displace
//     each other; a distinct virtual key per row keeps every row and counts the defect.

import {
  TRANSCRIPT_GEOMETRY_EPSILON_PX,
  TRANSCRIPT_WINDOW_ROW_CAP,
  TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX,
} from "./viewport-constants.js";

/**
 * The display facts a measurement is only valid under.
 *
 * Two members and not the whole `window`: these are the two that change a row's
 * laid-out height without changing its content.
 */
export interface RowDisplaySettings {
  readonly devicePixelRatio: number;
  readonly rootFontSizePx: number;
}

/** The keys the virtualizer is given, and what projecting them cost. */
export interface RowKeyProjection {
  /** One distinct key per row, index-aligned with the rows they came from. */
  readonly virtualKeys: readonly string[];
  /** Repeats seen in this pass. Non-zero is a projection defect, not a crash. */
  readonly duplicateKeyCount: number;
}

/** Overrides for the estimate and the prior ceiling; both default to the shared constants. */
export interface RowMeasurementTableOptions {
  readonly estimatedRowHeightPx?: number;
  readonly measurementCap?: number;
}

const EMPTY_PROJECTION: RowKeyProjection = { virtualKeys: [], duplicateKeyCount: 0 };

/**
 * How a repeat's projected key is spelled, declared once.
 *
 * Read back by {@link RowMeasurementTable.forgetAllExcept}, which has to recover
 * the row a projected key was minted for. Two spellings of it would make the trim
 * drop a prior for a row still on screen.
 */
const REPEAT_KEY_SEPARATOR = "~repeat-";

/** Accepted row heights, display validity and distinct virtual keys for the virtualizer. */
export class RowMeasurementTable {
  readonly #estimatedRowHeightPx: number;
  readonly #measurementCap: number;
  /** Insertion-ordered, so the ceiling evicts the least recently measured. */
  readonly #acceptedHeightByRowKey = new Map<string, number>();

  #displaySettings: RowDisplaySettings | undefined;
  #cachedRowKeys: readonly string[] | undefined;
  #cachedProjection: RowKeyProjection = EMPTY_PROJECTION;

  public constructor(options: RowMeasurementTableOptions = {}) {
    this.#estimatedRowHeightPx = options.estimatedRowHeightPx ?? TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX;
    this.#measurementCap = options.measurementCap ?? TRANSCRIPT_WINDOW_ROW_CAP;
  }

  /**
   * Declare the display the measurements are being taken on.
   *
   * Returns whether the priors were discarded, so the caller can tell the
   * virtualizer to drop its own cache in the same act: two caches disagreeing about
   * a row's height is a scrollbar that never settles.
   */
  public setDisplaySettings(settings: RowDisplaySettings): boolean {
    const current = this.#displaySettings;
    if (
      current !== undefined &&
      current.devicePixelRatio === settings.devicePixelRatio &&
      current.rootFontSizePx === settings.rootFontSizePx
    ) {
      return false;
    }
    this.#displaySettings = settings;
    this.#acceptedHeightByRowKey.clear();
    return true;
  }

  /**
   * The height the virtualizer should record for a row, given what was observed.
   *
   * A non-positive or non-finite observation is not a measurement (an unlaid-out element
   * reports zero, which would collapse the window), so the last accepted height or the estimate
   * stands. An observation within the epsilon of the last one is the same height. Anything else
   * is accepted and becomes the newest entry in the bounded table.
   */
  public acceptedHeight(rowKey: string, observedHeightPx: number): number {
    const previous = this.#acceptedHeightByRowKey.get(rowKey);
    if (!Number.isFinite(observedHeightPx) || observedHeightPx <= 0) {
      return previous ?? this.#estimatedRowHeightPx;
    }
    if (
      previous !== undefined &&
      Math.abs(previous - observedHeightPx) < TRANSCRIPT_GEOMETRY_EPSILON_PX
    ) {
      return previous;
    }
    this.#acceptedHeightByRowKey.delete(rowKey);
    this.#acceptedHeightByRowKey.set(rowKey, observedHeightPx);
    while (this.#acceptedHeightByRowKey.size > this.#measurementCap) {
      const oldestKey = this.#acceptedHeightByRowKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#acceptedHeightByRowKey.delete(oldestKey);
    }
    return observedHeightPx;
  }

  /** Forget one row's prior — for a row the window pruned. */
  public forget(rowKey: string): void {
    this.#acceptedHeightByRowKey.delete(rowKey);
  }

  /**
   * Forgets every prior whose row is not in `retainedRowKeys`.
   *
   * Reaches priors `forget` cannot: a duplicate row measured under this module's private
   * `~repeat-` key, and a row the window let go without a prune. A prior for a retained row is
   * never dropped, so nothing on screen is re-measured.
   */
  public forgetAllExcept(retainedRowKeys: readonly string[]): void {
    const retained = new Set(retainedRowKeys);
    for (const measuredKey of [...this.#acceptedHeightByRowKey.keys()]) {
      if (!retained.has(rowKeyOfMeasuredKey(measuredKey))) {
        this.#acceptedHeightByRowKey.delete(measuredKey);
      }
    }
  }

  /** The height this table would report for a row, measured or estimated. */
  public heightOf(rowKey: string): number {
    return this.#acceptedHeightByRowKey.get(rowKey) ?? this.#estimatedRowHeightPx;
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
