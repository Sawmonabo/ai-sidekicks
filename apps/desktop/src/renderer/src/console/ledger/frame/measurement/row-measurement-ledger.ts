// The residuals the virtualizer does not cover.
//
// `Spec-023 §Console Libraries` adopts `@tanstack/react-virtual` for the timeline's
// virtualization "under our own scroll controller", and names the acceptance tests
// the adoption owes: "documented total-size cost, no hit-test per scroll event while
// following, epsilon compare on measurements, a bounded prior ceiling, display
// settings in the prior validity key, and duplicate keys degrading rather than
// discarding the window."
//
// The library answers two of those on its own — the total size is a memoized prefix
// walk over its own measurements, and our `observeElementOffset` hands it an offset
// the scroll chokepoint already sampled, so no scroll event costs a hit test. The
// other four are ours, because the library's own behaviour is the opposite of what
// this ledger needs:
//
//   • **Epsilon.** `virtual-core`'s `resizeItem` acts on `delta !== 0`, an exact
//     compare. A streaming row's observed height wobbles in the last fractional bit
//     every frame, so an exact compare invalidates the measurement cache sixty times
//     a second for a difference no display can show. `acceptedHeight` is what the
//     virtualizer's `measureElement` option returns, so the wobble never reaches it.
//   • **A prior ceiling.** `itemSizeCache` is a `Map` keyed by item key with no
//     eviction: priors for rows the window pruned an hour ago are a cache with no
//     reader. This ledger holds the priors it accepted, bounded and oldest-first.
//   • **Display validity.** A device-pixel-ratio or root-font-size change re-lays
//     out every row, so every measurement taken before it describes a layout that no
//     longer exists. The library has no notion of the display at all.
//   • **Duplicate keys.** A repeat is a projection defect, and the library's caches
//     are keyed by item key — two rows sharing a key share one measurement and one
//     element slot, so the second silently displaces the first. Projecting a
//     distinct virtual key per row keeps every row in the window and counts the
//     defect, which is degrading rather than discarding.
//
// Chromium caps an element's height at `LEDGER_MAX_ELEMENT_HEIGHT_PX`; past it a
// virtual list's size container stops growing and every row below is unreachable.
// The ledger reports that rather than leaving it a mystery in the scrollbar.

import {
  LEDGER_GEOMETRY_EPSILON_PX,
  LEDGER_MAX_ELEMENT_HEIGHT_PX,
  LEDGER_ROW_HEIGHT_ESTIMATE_PX,
  LEDGER_WINDOW_ROW_CAP,
} from "../frame-bounds.js";

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

export interface RowMeasurementLedgerOptions {
  readonly estimatedRowHeightPx?: number;
  readonly measurementCap?: number;
}

const EMPTY_PROJECTION: RowKeyProjection = { virtualKeys: [], duplicateKeyCount: 0 };

export class RowMeasurementLedger {
  readonly #estimatedRowHeightPx: number;
  readonly #measurementCap: number;
  /** Insertion-ordered, so the ceiling evicts the least recently measured. */
  readonly #acceptedHeightByRowKey = new Map<string, number>();

  #displaySettings: RowDisplaySettings | undefined;
  #cachedRowKeys: readonly string[] | undefined;
  #cachedProjection: RowKeyProjection = EMPTY_PROJECTION;

  public constructor(options: RowMeasurementLedgerOptions = {}) {
    this.#estimatedRowHeightPx = options.estimatedRowHeightPx ?? LEDGER_ROW_HEIGHT_ESTIMATE_PX;
    this.#measurementCap = options.measurementCap ?? LEDGER_WINDOW_ROW_CAP;
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
   * Three rules, in order:
   *
   *   • A non-positive or non-finite observation is not a measurement. An element
   *     that has not been laid out reports zero, and taking zero as a row's height
   *     collapses the window onto one screen of rows that are all at the same
   *     offset. The last accepted height stands, or the estimate does.
   *   • An observation inside the epsilon is the same height. This console never
   *     compares two measurements without one: sub-pixel layout noise would otherwise
   *     read as a resize and re-run the window on every frame.
   *   • Anything else is accepted, and takes the newest slot in the bounded table.
   */
  public acceptedHeight(rowKey: string, observedHeightPx: number): number {
    const previous = this.#acceptedHeightByRowKey.get(rowKey);
    if (!Number.isFinite(observedHeightPx) || observedHeightPx <= 0) {
      return previous ?? this.#estimatedRowHeightPx;
    }
    if (
      previous !== undefined &&
      Math.abs(previous - observedHeightPx) < LEDGER_GEOMETRY_EPSILON_PX
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

  public get measuredRowCount(): number {
    return this.#acceptedHeightByRowKey.size;
  }

  /** The height this ledger would report for a row, measured or estimated. */
  public heightOf(rowKey: string): number {
    return this.#acceptedHeightByRowKey.get(rowKey) ?? this.#estimatedRowHeightPx;
  }

  /**
   * Give every row a key of its own, and count the ones that arrived without.
   *
   * Cached against the array's identity, so a caller handing over a memoized array
   * pays the walk once. A caller that rebuilds the array every render pays it every
   * render — a cost the caller controls and this class documents, rather than a deep
   * compare this class performs on its behalf.
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
        // The repeat is a different row wearing a name that is already taken. A
        // distinct virtual key keeps it in the window with a measurement and an
        // element slot of its own, rather than displacing the row that got there
        // first — which is what sharing a key with the library's caches would do.
        duplicateKeyCount += 1;
        virtualKeys[index] = `${rowKey}~repeat-${String(duplicateKeyCount)}`;
        continue;
      }
      seenKeys.add(rowKey);
      virtualKeys[index] = rowKey;
    }
    this.#cachedRowKeys = rowKeys;
    this.#cachedProjection = { virtualKeys, duplicateKeyCount };
    return this.#cachedProjection;
  }

  /** Whether a total height has passed the tallest box a browser will place. */
  public isPastElementCeiling(totalHeightPx: number): boolean {
    return totalHeightPx > LEDGER_MAX_ELEMENT_HEIGHT_PX;
  }
}
