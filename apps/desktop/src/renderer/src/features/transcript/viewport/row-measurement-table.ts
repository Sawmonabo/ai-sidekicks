// The residuals the virtualizer does not cover.
//
// `@tanstack/react-virtual` is adopted for the transcript's virtualization under our own
// scroll controller, and the adoption owes a named set of acceptance tests: documented
// total-size cost, no hit-test per scroll event while following, epsilon compare on
// measurements, a bounded prior ceiling, display settings in the prior validity key, and
// duplicate keys degrading rather than discarding the window.
//
// The library answers two of those on its own — the total size is a memoized prefix
// walk over its own measurements, and our `observeElementOffset` hands it an offset
// the scroll chokepoint already sampled, so no scroll event costs a hit test. The
// other four are ours, because the library's own behavior is the opposite of what
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
//     element entry, so the second silently displaces the first. Projecting a
//     distinct virtual key per row keeps every row in the window and counts the
//     defect, which is degrading rather than discarding.

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../frame/frame-caps.js";
import {
  TRANSCRIPT_GEOMETRY_EPSILON_PX,
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
   * Three rules, in order:
   *
   *   • A non-positive or non-finite observation is not a measurement. An element
   *     that has not been laid out reports zero, and taking zero as a row's height
   *     collapses the window onto one screen of rows that are all at the same
   *     offset. The last accepted height stands, or the estimate does.
   *   • An observation inside the epsilon is the same height. This console never
   *     compares two measurements without one: sub-pixel layout noise would otherwise
   *     read as a resize and re-run the window on every frame.
   *   • Anything else is accepted, and takes the newest entry in the bounded table.
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
   * Forget every prior whose row the window no longer holds. Answers how many.
   *
   * THE RESIDUE `forget` LEAVES. The cap forgets each key it drops, and that is
   * exact for every row that had a key of its own — but a prior also survives a
   * display-settings pass that did not fire, a duplicate row whose measured key is
   * this module's own `~repeat-` projection and which no caller can name, and a row
   * the window let go without a prune. The table is bounded, so none of that grows
   * without limit; it simply stays resident on a session that has gone quiet, which
   * is what the idle trim in `../viewport/cycle/idle-trim.ts` releases.
   *
   * SAFE BY CONSTRUCTION, which is why the argument is the retained set rather than
   * a count or an age: a prior for a row still in the window is never dropped, so
   * nothing on screen is re-measured and no offset moves. A dropped prior costs one
   * measurement the next time that row is read back, which is exactly what a row
   * that has never been measured already costs.
   *
   * The repeat suffix is stripped HERE because it is minted here: a caller holding
   * row keys cannot know that a duplicate row was measured under a projected name,
   * and asking it to reconstruct one would put this module's private spelling in
   * two places.
   */
  public forgetAllExcept(retainedRowKeys: readonly string[]): number {
    const retained = new Set(retainedRowKeys);
    let forgottenCount = 0;
    for (const measuredKey of [...this.#acceptedHeightByRowKey.keys()]) {
      if (retained.has(rowKeyOfMeasuredKey(measuredKey))) {
        continue;
      }
      this.#acceptedHeightByRowKey.delete(measuredKey);
      forgottenCount += 1;
    }
    return forgottenCount;
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
        // element entry of its own, rather than displacing the row that got there
        // first — which is what sharing a key with the library's caches would do.
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
 * The row a measured key was recorded under.
 *
 * The ordinal is checked rather than assumed, so a row whose own key happens to
 * contain the separator is not truncated into a row that does not exist — which
 * would drop the prior of a row still in the window.
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
