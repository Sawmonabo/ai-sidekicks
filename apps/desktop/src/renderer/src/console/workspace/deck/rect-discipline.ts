// Rect discipline — THIS MODULE'S OWN RULE, stated here because it is the one place
// that implements it and no committed document states it.
//
// Every pane, and every native overlay the browser pane hosts, tracks its rect from four
// invalidation sources: a `ResizeObserver` on the host, window resize, capture-phase
// scroll on any ancestor, and layout movers (pane widths, rail collapse, theme change).
// A `flushRect` step dedupes on a composed key so one frame produces one write. Native
// views hide when either dimension of the visible clip is below one pixel. Overlay
// elements register in an airspace registry on mount so a native view yields to them or
// hides while one is up — which is the airspace half `Spec-023 §Console Libraries` owns
// by name on its native-browser-view row: "OWN-BUILD the bounds bridge, the airspace
// policy (hide the view and swap in a `capturePage` image while an overlay is open)".
//
// TWO RULES DO ALL THE WORK, and both are about WHEN rather than what:
//
//   1. **Reads in the callback, writes on the next frame.** Measuring inside a
//      `ResizeObserver` callback is what the callback is for; mutating layout there
//      re-enters the observer and the browser reports `ResizeObserver loop
//      completed with undelivered notifications` — or, worse, does not, and the
//      pane oscillates a pixel a frame forever. This class is the one implementation
//      of the prohibition, so no pane has to remember it.
//   2. **One write per frame, per composed key.** Four invalidation sources fire
//      for one visual change — a drag moves a pane, which resizes it, which scrolls
//      an ancestor, on a window that is itself being resized. Without the dedupe
//      that is four writes for one moved edge.
//
// The clock is a dependency rather than a bare `requestAnimationFrame`, on
// `store/scheduling.ts`' reasoning: a frozen clock is what lets a test assert that
// the write did NOT happen during the callback and DID happen on the next frame.
// Nothing here arms an interval.
//
// WHAT a rect is — the clip walk, the invalidation vocabulary, and the dedupe key —
// is `rect-geometry.ts`, which holds no state and answers on demand. This module is
// only the WHEN.

import { useEffect, useRef, useState } from "react";

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { NATIVE_VIEW_MINIMUM_VISIBLE_PX } from "../workspace-bounds.js";
import {
  rectKey,
  visibleClipOf,
  type RectInvalidationSource,
  type TrackedRect,
} from "./rect-geometry.js";

/**
 * Which overlays are up.
 *
 * Dialogs, popovers, context menus, toasts, and lightboxes register on mount; a
 * native view yields while any of them is registered. A registry rather than a
 * boolean because two overlays can be up at once and a boolean would let the first
 * one to close hand the airspace back while the second is still on screen.
 *
 * An instance rather than a module singleton, because an auxiliary window is its
 * own renderer with its own overlays — the same no-shared-state property I-023-12
 * states for stores.
 */
export class AirspaceRegistry {
  readonly #occupants = new Set<string>();
  readonly #changes = new Emitter<boolean>("airspace change");

  /**
   * Claim the airspace. The returned function is the only way to release it.
   *
   * Emits on the false→true TRANSITION only, matching the release side, which
   * already emits only where the delete removed something. A second overlay opening
   * above the first changes nothing a subscriber would act on, and emitting for it
   * would spend a re-measure of every tracked pane on an answer that cannot differ.
   */
  public claim(overlayId: string): Unsubscribe {
    const wasOccupied = this.#occupants.size > 0;
    this.#occupants.add(overlayId);
    if (!wasOccupied) {
      this.#changes.emit(true);
    }
    return () => {
      if (this.#occupants.delete(overlayId)) {
        this.#changes.emit(this.#occupants.size > 0);
      }
    };
  }

  public get isOccupied(): boolean {
    return this.#occupants.size > 0;
  }

  public subscribe(listener: (isOccupied: boolean) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }
}

export interface PaneRectTrackerOptions {
  readonly clock: ConsoleClock;
  /** Where a deduped batch of rects is written. Called at most once per frame. */
  readonly onFlush: (rects: readonly TrackedRect[]) => void;
  readonly airspace?: AirspaceRegistry;
}

export class PaneRectTracker {
  readonly #clock: ConsoleClock;
  readonly #onFlush: (rects: readonly TrackedRect[]) => void;
  readonly #airspace: AirspaceRegistry | undefined;
  readonly #elementsByPaneId = new Map<string, Element>();
  readonly #pendingByPaneId = new Map<string, TrackedRect>();
  readonly #lastKeyByPaneId = new Map<string, string>();
  readonly #invalidationCountBySource = new Map<RectInvalidationSource, number>();
  readonly #releaseAirspace: Unsubscribe | undefined;
  #armedHandle: ScheduledHandle | undefined;
  #flushCount = 0;
  #writesDuringMeasurement = 0;
  #disposed = false;

  public constructor(options: PaneRectTrackerOptions) {
    this.#clock = options.clock;
    this.#onFlush = options.onFlush;
    this.#airspace = options.airspace;
    // Subscribed HERE rather than sampled at each invalidation, because an overlay
    // opening fires none of the other four sources: the palette deliberately does not
    // lock document scroll and its inert carrier is `display: contents`, so nothing
    // about one appearing changes layout. Visibility is part of the dedupe key, so
    // without this the last flushed value simply stood — a native view composited over
    // a dialog that had just opened, or hidden after one had closed.
    this.#releaseAirspace = options.airspace?.subscribe(() => {
      this.invalidate("airspace");
    });
  }

  /** Flushes performed. One per frame that held a changed rect; the dedupe assertion. */
  public get flushCount(): number {
    return this.#flushCount;
  }

  /**
   * Measurements taken while a flush was running.
   *
   * Counted rather than ignored: a host that mutates layout from inside `onFlush`
   * re-enters measurement, which is the loop rule 1 forbids, and a count is how it
   * becomes visible instead of being felt as a stutter.
   */
  public get reentrantMeasurementCount(): number {
    return this.#writesDuringMeasurement;
  }

  /**
   * How many times each source asked for a re-measure.
   *
   * The counter that makes the dedupe claim checkable rather than asserted: four
   * sources firing for one moved edge should read as four invalidations and one
   * flush, and only a per-source count can tell that apart from one source firing
   * four times, which is a different defect.
   */
  public invalidationCount(source: RectInvalidationSource): number {
    return this.#invalidationCountBySource.get(source) ?? 0;
  }

  public track(paneId: string, element: Element): void {
    this.#elementsByPaneId.set(paneId, element);
    this.invalidate("layout-mover");
  }

  public untrack(paneId: string): void {
    this.#elementsByPaneId.delete(paneId);
    this.#pendingByPaneId.delete(paneId);
    this.#lastKeyByPaneId.delete(paneId);
  }

  /**
   * Re-measure every tracked pane and QUEUE the result. Never writes.
   *
   * This is the function all four invalidation sources call — the
   * `ResizeObserver` callback, the window's `resize` listener, the capture-phase
   * `scroll` listener, and the deck itself when it moves a pane. It reads the DOM
   * and arms one frame; the host's write happens there and nowhere else.
   */
  public invalidate(source: RectInvalidationSource): void {
    if (this.#disposed) {
      return;
    }
    this.#invalidationCountBySource.set(
      source,
      (this.#invalidationCountBySource.get(source) ?? 0) + 1,
    );
    const isAirspaceOccupied = this.#airspace?.isOccupied === true;
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
   * Write the queued rects that actually changed, then disarm.
   *
   * The ONE write path. The armed frame calls it, and it is public so a host that
   * is about to hand a rect to a native view can force delivery rather than wait a
   * frame it does not have. A rect whose key is unchanged is not written at all,
   * which is what keeps a scroll that moves nothing from costing a message.
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

  /** Drop everything armed. Terminal: a later invalidation measures nothing. */
  public dispose(): void {
    this.#disposed = true;
    // Released before anything else, and safe against a racing emit either way:
    // `invalidate` early-returns once disposed.
    this.#releaseAirspace?.();
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

/**
 * Hold one tracker for the lifetime of the surface that owns the panes.
 *
 * The sink is held in a ref and updated in an effect rather than captured at
 * construction, so a caller passing an inline lambda does not rebuild the tracker
 * every render — which would reset its dedupe memory and turn every frame into a
 * write, the exact opposite of what it is for.
 */
export function usePaneRectTracker(options: {
  readonly clock: ConsoleClock;
  readonly onRects?: (rects: readonly TrackedRect[]) => void;
  readonly airspace?: AirspaceRegistry;
}): PaneRectTracker {
  const sink = useRef(options.onRects);
  useEffect(() => {
    sink.current = options.onRects;
  }, [options.onRects]);

  const [tracker] = useState(
    () =>
      new PaneRectTracker({
        clock: options.clock,
        onFlush: (rects) => sink.current?.(rects),
        ...(options.airspace === undefined ? {} : { airspace: options.airspace }),
      }),
  );

  useEffect(
    () => () => {
      tracker.dispose();
    },
    [tracker],
  );
  return tracker;
}

/**
 * Wire the four invalidation sources to a tracker, for as long as `container` is
 * mounted.
 *
 * All four in ONE effect, because they are one subscription to one question — "has
 * anything moved?" — and splitting them across effects would make the teardown
 * order decide whether a listener outlives the observer it was installed beside.
 *
 * Scroll is listened for in the CAPTURE phase on the document: a scroll inside any
 * ancestor of a pane moves that pane on screen, and scroll events do not bubble
 * from an element to the window, so a bubble-phase window listener would miss every
 * one that mattered.
 *
 * `layoutRevision` is the fourth source — the layout movers. Passing the layout's
 * own revision counter means a pane width change, a reorder, and a density change
 * all re-measure without this module having to know what any of them are.
 */
export function usePaneRectSources(
  tracker: PaneRectTracker,
  container: React.RefObject<HTMLElement | null>,
  layoutRevision: number,
): void {
  useEffect(() => {
    const element = container.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      // A READ, queued. Mutating layout from inside this callback re-enters the
      // observer, which is the loop this module's rule 1 forbids.
      tracker.invalidate("host-resize");
    });
    observer.observe(element);

    const onWindowResize = (): void => {
      tracker.invalidate("window-resize");
    };
    const onAncestorScroll = (): void => {
      tracker.invalidate("ancestor-scroll");
    };
    window.addEventListener("resize", onWindowResize);
    document.addEventListener("scroll", onAncestorScroll, { capture: true, passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("scroll", onAncestorScroll, { capture: true });
    };
  }, [tracker, container]);

  useEffect(() => {
    tracker.invalidate("layout-mover");
  }, [tracker, layoutRevision]);
}
