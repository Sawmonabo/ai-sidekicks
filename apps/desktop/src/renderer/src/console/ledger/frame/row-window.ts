// The row window — which rows the viewport actually mounts, and where they sit.
//
// `Spec-023 §Console Libraries` adopts `@tanstack/react-virtual` "under our own
// scroll controller" for this job and is explicit that the surrounding controller
// is ours: "The reading anchor, follow, and window-cap controller is own-build (no
// library has a sub-row reading anchor)." The library is not a dependency of this
// package at this revision, so the measurement half is own-build too — and it is
// held to the SAME residuals that verdict row required of the library, because they
// are properties of a correct virtualizer rather than of a particular one:
//
//   • **The total size's cost is documented.** Offsets come from a prefix sum over
//     the window's keys, rebuilt only when the key array identity changes or a
//     measurement lands: O(rows) on a rebuild and O(1) on every scroll frame in
//     between. The window cap bounds `rows`, so the rebuild is bounded too.
//   • **Measurements compare with an epsilon.** A `ResizeObserver` reports
//     fractional heights that differ in the last bit between frames; an exact
//     compare would invalidate the prefix sum on every frame of a stream.
//   • **The prior table has a ceiling.** Measurements are bounded by the window's
//     own row cap and evict oldest-first: a table of priors for rows that have been
//     pruned is a cache with no reader.
//   • **Display settings are part of the priors' validity key.** A device-pixel
//     ratio or root font-size change re-lays out every row, so every measurement
//     taken before it describes a layout that no longer exists.
//   • **Duplicate keys degrade, never discard.** A repeated key is a projection
//     defect, and the honest response is to render every row using the estimate for
//     the repeat and count it — not to drop the window and show the reader nothing.
//
// Chromium caps an element's height at `LEDGER_MAX_ELEMENT_HEIGHT_PX`. The total is
// clamped to it and the clamp is reported rather than silent, because a spacer
// taller than that stops growing and every row below it becomes unreachable.

import {
  LEDGER_GEOMETRY_EPSILON_PX,
  LEDGER_MAX_ELEMENT_HEIGHT_PX,
  LEDGER_OVERSCAN_ROWS,
  LEDGER_ROW_HEIGHT_ESTIMATE_PX,
  LEDGER_WINDOW_ROW_CAP,
} from "./frame-bounds.js";

/** What the viewport mounts, and the spacer above it. */
export interface RowWindowRange {
  readonly startIndex: number;
  /** Exclusive, so `endIndex - startIndex` is the mounted count. */
  readonly endIndex: number;
  readonly offsetBeforeStartPx: number;
  readonly totalHeightPx: number;
  /** True when the content is taller than a browser can place. */
  readonly isClampedToElementCeiling: boolean;
  /** Repeated keys seen in this pass. Non-zero is a projection defect, not a crash. */
  readonly duplicateKeyCount: number;
}

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

export interface RowWindowOptions {
  readonly estimatedRowHeightPx?: number;
  readonly overscanRows?: number;
  readonly measurementCap?: number;
}

export class RowWindow {
  readonly #estimatedRowHeightPx: number;
  readonly #overscanRows: number;
  readonly #measurementCap: number;
  /** Insertion-ordered, so the ceiling evicts the least recently measured. */
  readonly #heightByRowKey = new Map<string, number>();

  #displaySettings: RowDisplaySettings | undefined;
  #cachedKeys: readonly string[] | undefined;
  #cachedPrefixOffsets: number[] = [];
  #cachedDuplicateKeyCount = 0;

  public constructor(options: RowWindowOptions = {}) {
    this.#estimatedRowHeightPx = options.estimatedRowHeightPx ?? LEDGER_ROW_HEIGHT_ESTIMATE_PX;
    this.#overscanRows = options.overscanRows ?? LEDGER_OVERSCAN_ROWS;
    this.#measurementCap = options.measurementCap ?? LEDGER_WINDOW_ROW_CAP;
  }

  /**
   * Declare the display the measurements were taken on.
   *
   * A change discards every prior: they describe a layout that no longer exists,
   * and keeping them would leave the scrollbar wrong until each row re-measured.
   */
  public setDisplaySettings(settings: RowDisplaySettings): void {
    const current = this.#displaySettings;
    if (
      current !== undefined &&
      current.devicePixelRatio === settings.devicePixelRatio &&
      current.rootFontSizePx === settings.rootFontSizePx
    ) {
      return;
    }
    this.#displaySettings = settings;
    this.#heightByRowKey.clear();
    this.#invalidate();
  }

  /**
   * Record a measured row height. Returns whether anything actually changed.
   *
   * The epsilon is what makes a streaming row affordable: its observed height wobbles
   * in the last fractional bit every frame, and treating that as a change would
   * rebuild the prefix sum sixty times a second for no visible difference.
   */
  public measure(rowKey: string, heightPx: number): boolean {
    if (!Number.isFinite(heightPx) || heightPx < 0) {
      return false;
    }
    const previous = this.#heightByRowKey.get(rowKey);
    if (previous !== undefined && Math.abs(previous - heightPx) < LEDGER_GEOMETRY_EPSILON_PX) {
      return false;
    }
    this.#heightByRowKey.delete(rowKey);
    this.#heightByRowKey.set(rowKey, heightPx);
    while (this.#heightByRowKey.size > this.#measurementCap) {
      const oldestKey = this.#heightByRowKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#heightByRowKey.delete(oldestKey);
    }
    this.#invalidate();
    return true;
  }

  /** Forget one row's measurement — for a row the window pruned. */
  public forget(rowKey: string): void {
    if (this.#heightByRowKey.delete(rowKey)) {
      this.#invalidate();
    }
  }

  public get measuredRowCount(): number {
    return this.#heightByRowKey.size;
  }

  /** Where a row's top edge sits, in the scroll surface's coordinates. */
  public offsetOf(rowKeys: readonly string[], index: number): number {
    const offsets = this.#prefixOffsets(rowKeys);
    return offsets[Math.max(0, Math.min(index, offsets.length - 1))] ?? 0;
  }

  /**
   * The rows to mount for a viewport, with overscan on both edges.
   *
   * `rowKeys` is expected to be a memoized array: the prefix sum is cached against
   * its identity, so a caller that rebuilds the array every render pays the rebuild
   * every render. That is a cost the caller controls and this class documents,
   * rather than a deep compare this class performs on its behalf.
   */
  public rangeFor(
    rowKeys: readonly string[],
    scrollTop: number,
    viewportHeight: number,
  ): RowWindowRange {
    const offsets = this.#prefixOffsets(rowKeys);
    const totalHeightPx = offsets[offsets.length - 1] ?? 0;
    if (rowKeys.length === 0) {
      return {
        startIndex: 0,
        endIndex: 0,
        offsetBeforeStartPx: 0,
        totalHeightPx: 0,
        isClampedToElementCeiling: false,
        duplicateKeyCount: 0,
      };
    }
    const firstVisible = this.#indexAtOffset(offsets, Math.max(0, scrollTop));
    const lastVisible = this.#indexAtOffset(
      offsets,
      Math.max(0, scrollTop) + Math.max(0, viewportHeight),
    );
    const startIndex = Math.max(0, firstVisible - this.#overscanRows);
    const endIndex = Math.min(rowKeys.length, lastVisible + 1 + this.#overscanRows);
    return {
      startIndex,
      endIndex,
      offsetBeforeStartPx: offsets[startIndex] ?? 0,
      totalHeightPx: Math.min(totalHeightPx, LEDGER_MAX_ELEMENT_HEIGHT_PX),
      isClampedToElementCeiling: totalHeightPx > LEDGER_MAX_ELEMENT_HEIGHT_PX,
      duplicateKeyCount: this.#cachedDuplicateKeyCount,
    };
  }

  /**
   * The prefix sum, rebuilt only when it has to be.
   *
   * `offsets[i]` is the top edge of row `i`, and `offsets[length]` is the total —
   * one array answering both questions, which is why the total costs nothing extra.
   */
  #prefixOffsets(rowKeys: readonly string[]): readonly number[] {
    if (this.#cachedKeys === rowKeys && this.#cachedPrefixOffsets.length === rowKeys.length + 1) {
      return this.#cachedPrefixOffsets;
    }
    const seenKeys = new Set<string>();
    const offsets: number[] = new Array<number>(rowKeys.length + 1);
    let duplicateKeyCount = 0;
    let runningOffset = 0;
    for (let index = 0; index < rowKeys.length; index += 1) {
      offsets[index] = runningOffset;
      const rowKey = rowKeys[index];
      if (rowKey === undefined) {
        runningOffset += this.#estimatedRowHeightPx;
        continue;
      }
      if (seenKeys.has(rowKey)) {
        // Degrade, never discard: the repeat is a different row wearing a name
        // that is already taken, so it takes the estimate rather than a
        // measurement that belongs to the first one.
        duplicateKeyCount += 1;
        runningOffset += this.#estimatedRowHeightPx;
        continue;
      }
      seenKeys.add(rowKey);
      runningOffset += this.#heightByRowKey.get(rowKey) ?? this.#estimatedRowHeightPx;
    }
    offsets[rowKeys.length] = runningOffset;
    this.#cachedKeys = rowKeys;
    this.#cachedPrefixOffsets = offsets;
    this.#cachedDuplicateKeyCount = duplicateKeyCount;
    return offsets;
  }

  /** The last index whose top edge is at or before `offset`. Binary, not linear. */
  #indexAtOffset(offsets: readonly number[], offset: number): number {
    let low = 0;
    let high = offsets.length - 2;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((offsets[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return Math.max(0, low);
  }

  #invalidate(): void {
    this.#cachedKeys = undefined;
    this.#cachedPrefixOffsets = [];
  }
}
