// Decides when each pane's visible rect is measured and written.
//
// Five sources invalidate a rect: a `ResizeObserver` on the host, window resize, capture-phase
// scroll on any ancestor, layout movers (pane widths, rail collapse, theme change), and an
// overlay opening or closing in the window's airspace. A native view hides while any overlay
// is registered, or when either dimension of its visible clip is under
// `NATIVE_VIEW_MINIMUM_VISIBLE_PX`.
//
// Two rules do the work:
//   1. Reads in the callback, writes on the next frame. Mutating layout inside a
//      `ResizeObserver` callback re-enters the observer and can oscillate a pane a pixel per
//      frame forever.
//   2. One write per frame per composed key. Several sources fire for one visual change, and
//      each would otherwise write.
//
// The clock is injected so a test can assert the write did not happen in the callback and did
// on the next frame. Nothing here arms an interval. What a rect is lives in
// `pane-rect-geometry.ts`.

import { type AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { NATIVE_VIEW_MINIMUM_VISIBLE_PX } from "./pane-layout-measures.js";
import {
  rectKey,
  visibleClipOf,
  type RectInvalidationSource,
  type TrackedRect,
} from "./pane-rect-geometry.js";

/** What a tracker is built from: its frame clock, its write sink and the window's airspace. */
export interface PaneRectTrackerOptions {
  readonly clock: Clock;
  /** Where a deduped batch of rects is written. Called at most once per frame. */
  readonly onFlush: (rects: readonly TrackedRect[]) => void;
  /** Which overlays are up in this window, so a pane's rect yields while one is. */
  readonly airspace: AirspaceRegistry;
}

/** Tracks each pane's visible rect and writes the changed ones at most once per frame. */
export class PaneRectTracker {
  readonly #clock: Clock;
  readonly #onFlush: (rects: readonly TrackedRect[]) => void;
  readonly #airspace: AirspaceRegistry;
  readonly #elementsByPaneId = new Map<string, Element>();
  readonly #pendingByPaneId = new Map<string, TrackedRect>();
  readonly #lastKeyByPaneId = new Map<string, string>();
  readonly #invalidationCountBySource = new Map<RectInvalidationSource, number>();
  readonly #releaseAirspace: Unsubscribe;
  #wasAirspaceOccupied: boolean;
  #armedHandle: ScheduledHandle | undefined;
  #flushCount = 0;
  #writesDuringMeasurement = 0;
  #disposed = false;

  public constructor(options: PaneRectTrackerOptions) {
    this.#clock = options.clock;
    this.#onFlush = options.onFlush;
    this.#airspace = options.airspace;
    this.#wasAirspaceOccupied = options.airspace.registeredCount > 0;
    // Subscribed rather than sampled per invalidation: an overlay opening fires no other
    // source (it changes no layout), and visibility is part of the dedupe key, so the last
    // flushed value would stand over a dialog.
    //
    // Filtered to the empty/occupied transition: a second overlay or a moving overlay cannot
    // change the answer, and re-measuring every pane for them is wasted work.
    this.#releaseAirspace = options.airspace.subscribeToChanges(() => {
      const isOccupied = this.#airspace.registeredCount > 0;
      if (isOccupied === this.#wasAirspaceOccupied) {
        return;
      }
      this.#wasAirspaceOccupied = isOccupied;
      this.invalidate("airspace");
    });
  }

  /** Flushes performed: one per frame that held a changed rect. */
  public get flushCount(): number {
    return this.#flushCount;
  }

  /** Measurements queued while a flush was running: a host mutating layout inside `onFlush`. */
  public get reentrantMeasurementCount(): number {
    return this.#writesDuringMeasurement;
  }

  /** How many times `source` asked for a re-measure; separates many sources from one repeating. */
  public invalidationCount(source: RectInvalidationSource): number {
    return this.#invalidationCountBySource.get(source) ?? 0;
  }

  /** Starts measuring `element` as the pane `paneId`. */
  public track(paneId: string, element: Element): void {
    this.#elementsByPaneId.set(paneId, element);
    this.invalidate("layout-mover");
  }

  /** Stops measuring a pane and forgets its pending and last-written rect. */
  public untrack(paneId: string): void {
    this.#elementsByPaneId.delete(paneId);
    this.#pendingByPaneId.delete(paneId);
    this.#lastKeyByPaneId.delete(paneId);
  }

  /** Re-measures every tracked pane and queues the result for the next frame; never writes. */
  public invalidate(source: RectInvalidationSource): void {
    if (this.#disposed) {
      return;
    }
    this.#invalidationCountBySource.set(
      source,
      (this.#invalidationCountBySource.get(source) ?? 0) + 1,
    );
    // The policy is to hide the view while any overlay is open, so this counts overlays; the
    // per-pane intersection belongs to the preview geometry publisher.
    const isAirspaceOccupied = this.#airspace.registeredCount > 0;
    this.#wasAirspaceOccupied = isAirspaceOccupied;
    for (const [paneId, element] of this.#elementsByPaneId) {
      const clip = visibleClipOf(element);
      const isLargeEnough =
        clip.width >= NATIVE_VIEW_MINIMUM_VISIBLE_PX &&
        clip.height >= NATIVE_VIEW_MINIMUM_VISIBLE_PX;
      this.#pendingByPaneId.set(paneId, {
        paneId,
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        isVisible: isLargeEnough && !isAirspaceOccupied,
      });
    }
    this.#arm();
  }

  /**
   * Writes the queued rects whose key changed, then disarms. The armed frame calls it; a host
   * about to hand a rect to a native view may call it to force delivery.
   */
  public flush(): void {
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    const changed: TrackedRect[] = [];
    for (const [paneId, rect] of this.#pendingByPaneId) {
      const key = rectKey(rect);
      if (this.#lastKeyByPaneId.get(paneId) === key) {
        continue;
      }
      this.#lastKeyByPaneId.set(paneId, key);
      changed.push(rect);
    }
    this.#pendingByPaneId.clear();
    if (changed.length === 0) {
      return;
    }
    this.#flushCount += 1;
    const measurementsBefore = this.#pendingByPaneId.size;
    this.#onFlush(changed);
    if (this.#pendingByPaneId.size > measurementsBefore) {
      this.#writesDuringMeasurement += 1;
    }
  }

  /** Drops everything armed. Terminal: a later invalidation measures nothing. */
  public dispose(): void {
    this.#disposed = true;
    // `invalidate` returns early once disposed, so a racing emit is harmless.
    this.#releaseAirspace();
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    this.#elementsByPaneId.clear();
    this.#pendingByPaneId.clear();
    this.#lastKeyByPaneId.clear();
  }

  #arm(): void {
    if (this.#armedHandle !== undefined) {
      return;
    }
    this.#armedHandle = this.#clock.scheduleFrame(() => {
      this.#armedHandle = undefined;
      this.flush();
    });
  }
}
