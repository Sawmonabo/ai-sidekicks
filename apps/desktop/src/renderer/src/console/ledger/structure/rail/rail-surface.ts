// The rail's surface watch — when its rendered box or the host's pixel ratio moves.
//
// A canvas has TWO sizes: the CSS box the browser lays out, and the backing store
// the drawing commands land in. Nothing keeps them in step on its own, so a canvas
// that is never sized carries the 300x150 default while CSS stretches it over the
// rail's full height — every mark scaled by that ratio, and every one of them
// blurred by the resample. `rail-painter.ts` sizes the store; this module is what
// tells it that the size has changed.
//
// TWO SOURCES, BOTH EVENT-DRIVEN. The box changes when the window, the deck, or the
// pane does; the pixel ratio changes when the window moves to a display with a
// different density or the operator changes the system's scale. Neither is
// pollable without a frame loop, and a frame loop on a surface that is static at
// rest is exactly what `Spec-023 §Console Design (Meridian)`'s frame budget is
// against — so both arrive as events and the rail repaints on them and at no other
// time.
//
// THE PIXEL-RATIO QUERY RE-ARMS ITSELF. `(resolution: Ndppx)` matches one ratio, so
// the query that reports the change is stale the instant it fires: it is released
// and a query for the NEW ratio is armed in its place. A single query armed once
// would report the first move to a second display and nothing after it.
//
// EVERY HOST READING IS GUARDED. A DOM shim has no `ResizeObserver` and no
// `matchMedia`, and a host that cannot observe is not a failure — the rail paints
// once at mount and stays operable, because its slider, keyboard walk, preview, and
// clip affordance are all DOM.

import { useEffect, useState, type RefObject } from "react";

import type { Unsubscribe } from "../../../core/index.js";

/** A watch that observes nothing, for a host that provides the mechanism. */
const NO_SURFACE_WATCH: Unsubscribe = () => {
  // Intentionally empty: there is nothing to release when nothing was observed.
};

/**
 * How the watch learns that something moved.
 *
 * Injected rather than reached for, so the `console-unit` tier drives the
 * re-arming and the release order against fakes instead of against a browser it
 * does not have.
 */
export interface RailSurfaceObservers {
  /** Watch one element's rendered box. */
  readonly observeBox: (element: Element, onChange: () => void) => Unsubscribe;
  /** Watch the host's device pixel ratio. */
  readonly observeDevicePixelRatio: (onChange: () => void) => Unsubscribe;
}

/**
 * The host's own device pixel ratio, or 1 where it answers nothing usable.
 *
 * One reading, shared with the painter: two readings would let the store be sized
 * for one ratio and the context scaled for another, which is the blur this whole
 * module exists to remove.
 */
export function hostDevicePixelRatio(): number {
  const ratio = (globalThis as { readonly devicePixelRatio?: number }).devicePixelRatio;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** What the console observes with in a browser. */
export const hostRailSurfaceObservers: RailSurfaceObservers = {
  observeBox: observeHostBox,
  observeDevicePixelRatio: observeHostDevicePixelRatio,
};

/**
 * Watch one element's surface. Returns the release, which drops both observations.
 *
 * A function rather than a class because it holds nothing between calls: the two
 * releases live for exactly the call's own lifetime, and a class would publish a
 * handle whose only method is the one this return value already is.
 */
export function watchRailSurface(
  element: Element,
  onChange: () => void,
  observers: RailSurfaceObservers = hostRailSurfaceObservers,
): Unsubscribe {
  const releaseBox = observers.observeBox(element, onChange);
  const releaseRatio = observers.observeDevicePixelRatio(onChange);
  return () => {
    releaseBox();
    releaseRatio();
  };
}

/**
 * The rail's repaint trigger, as a number that changes when the surface does.
 *
 * A revision rather than the measurements themselves: the painter reads the box
 * and the ratio at paint time from the canvas it was handed, so publishing them
 * here would be a second measurement that could disagree with the one that draws.
 *
 * The element is read once, on mount: the canvas node is a stable JSX child of the
 * rail for the component's whole life, so re-reading the ref would re-arm two
 * observers on the same element for nothing.
 */
export function useRailSurfaceRevision(
  elementRef: RefObject<HTMLCanvasElement | null>,
  observers: RailSurfaceObservers = hostRailSurfaceObservers,
): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const element = elementRef.current;
    if (element === null) {
      return undefined;
    }
    return watchRailSurface(
      element,
      () => {
        setRevision((previous) => previous + 1);
      },
      observers,
    );
  }, [elementRef, observers]);
  return revision;
}

/** `ResizeObserver` where the host has one. */
function observeHostBox(element: Element, onChange: () => void): Unsubscribe {
  const observerHost = globalThis as { readonly ResizeObserver?: typeof ResizeObserver };
  const ObserverConstructor = observerHost.ResizeObserver;
  if (ObserverConstructor === undefined) {
    return NO_SURFACE_WATCH;
  }
  const observer = new ObserverConstructor(() => {
    onChange();
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
}

/** A `(resolution: Ndppx)` query that re-arms itself on every move. */
function observeHostDevicePixelRatio(onChange: () => void): Unsubscribe {
  const mediaHost = globalThis as {
    readonly matchMedia?: (query: string) => MediaQueryList;
  };
  const matchMedia = mediaHost.matchMedia;
  if (typeof matchMedia !== "function") {
    return NO_SURFACE_WATCH;
  }
  let released = false;
  let releaseQuery: Unsubscribe = NO_SURFACE_WATCH;
  const arm = (): Unsubscribe => {
    const query = matchMedia.call(
      globalThis,
      `(resolution: ${String(hostDevicePixelRatio())}dppx)`,
    );
    const handleRatioChange = (): void => {
      releaseQuery();
      if (released) {
        return;
      }
      releaseQuery = arm();
      onChange();
    };
    query.addEventListener("change", handleRatioChange);
    return () => {
      query.removeEventListener("change", handleRatioChange);
    };
  };
  releaseQuery = arm();
  return () => {
    released = true;
    releaseQuery();
  };
}
