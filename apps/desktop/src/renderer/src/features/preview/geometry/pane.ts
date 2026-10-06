// Where the native view may be and when it yields: the pure arithmetic half of pane geometry,
// with no DOM and nothing scheduled. The sampling half is `publisher.ts`, and samples
// go to the page host in `page-host.ts`. `PaneOverlaySource` is the narrow port onto
// `lib/airspace.ts`, so the two modules do not cycle.

import { type AirspaceMotionObserver, type AirspaceRect } from "#renderer/lib/airspace.js";
import type { Unsubscribe } from "#shared/preload-api.js";

/** Two-decimal rounding as a factor; `toFixed` would be a second number formatter. */
const GEOMETRY_ROUNDING_FACTOR = 100;

/** Below this edge length there is nothing to show; one, since a rounded box can be 0.4 px tall. */
const MINIMUM_VISIBLE_EDGE_PX = 1;

/**
 * A rectangle in CSS pixels, viewport-relative, already rounded. The airspace's own rect, so
 * overlay and pane rectangles compare as one shape.
 */
export type PaneRect = AirspaceRect;

/** Why a sample hides the view: the pane is below the minimum edge, or an overlay covers it. */
export const PANE_GEOMETRY_HIDDEN_REASONS = ["below-minimum-edge", "occluded"] as const;

/** One of `PANE_GEOMETRY_HIDDEN_REASONS`. */
export type PaneGeometryHiddenReason = (typeof PANE_GEOMETRY_HIDDEN_REASONS)[number];

/** Why a sample was taken, carried on every publish so a diagnostic can name a silent source. */
export const GEOMETRY_INVALIDATION_REASONS = [
  "attach",
  "resize-observer",
  "window-resize",
  "document-scroll",
  "layout-mover",
  "theme-change",
  "overlay-change",
] as const;

/** One of `GEOMETRY_INVALIDATION_REASONS`. */
export type GeometryInvalidationReason = (typeof GEOMETRY_INVALIDATION_REASONS)[number];

/**
 * One reading of where the pane is and whether the view may be shown there. It travels whole so
 * a page host can compare `key` against what it last applied; a rectangle is never assumed
 * current after an await.
 */
export interface PaneGeometrySample {
  /** The pane's own box, intersected against every clipping ancestor. */
  readonly rect: PaneRect;
  /** The tightest clip that produced it, for a page host that masks rather than moves. */
  readonly clip: PaneRect;
  readonly visible: boolean;
  /** Why it is not visible. `undefined` on a visible sample. */
  readonly hiddenBecause: PaneGeometryHiddenReason | undefined;
  /** The dedupe key. Equal keys are the same publish and the second is skipped. */
  readonly key: string;
  readonly reason: GeometryInvalidationReason;
  readonly sampledAtMs: number;
}

/**
 * What the publisher needs from the overlay registry, as a port so the two do not cycle. The
 * view always yields: an overlay is never dimmed or displaced for a native rectangle.
 */
export interface PaneOverlaySource {
  /** Every overlay rectangle on screen right now. */
  liveRects(): readonly PaneRect[];
  /** Fires when an overlay opens or closes, so a publisher re-samples immediately. */
  subscribeToChanges(sink: () => void): Unsubscribe;
  /**
   * Watches every registered overlay element for movement until the returned disposer is
   * called. It is on the port because the registry arms no frame of its own; the publisher
   * installs it and `dispose` retires it with the other sources.
   */
  installMotionObserver(observe: AirspaceMotionObserver): Unsubscribe;
}

/** What a sample is computed from. Pure inputs, so the arithmetic is testable. */
export interface PaneGeometryInput {
  readonly hostRect: PaneRect;
  /** Every clipping ancestor's box, outermost first. Empty when nothing clips. */
  readonly clipRects: readonly PaneRect[];
  readonly overlayRects: readonly PaneRect[];
  readonly reason: GeometryInvalidationReason;
  readonly sampledAtMs: number;
}

/**
 * Rounds a raw box to the sample's precision. The one rounding, because the publisher's dedupe is
 * a string comparison over these numbers.
 */
export function roundPaneRect(box: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): PaneRect {
  return {
    x: roundCoordinate(box.x),
    y: roundCoordinate(box.y),
    width: roundCoordinate(box.width),
    height: roundCoordinate(box.height),
  };
}

/** The overlap of two rectangles, or a zero-area rectangle where they do not meet. */
export function intersectRects(first: PaneRect, second: PaneRect): PaneRect {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return {
    x: roundCoordinate(left),
    y: roundCoordinate(top),
    width: roundCoordinate(Math.max(0, right - left)),
    height: roundCoordinate(Math.max(0, bottom - top)),
  };
}

/**
 * Composes one sample as a pure function. The host rectangle is narrowed by every clipping
 * ancestor, since a pane scrolled behind an overflow edge has a bounding box nowhere visible and
 * publishing it would paint the page over the chrome. The view hides below one pixel on either
 * axis of the rectangle or the clip, and when an overlay covers it.
 */
export function composePaneGeometrySample(input: PaneGeometryInput): PaneGeometrySample {
  const clip = input.clipRects.reduce<PaneRect>(
    (narrowed, ancestor) => intersectRects(narrowed, ancestor),
    input.hostRect,
  );
  const rect = intersectRects(input.hostRect, clip);
  const hiddenBecause = readHiddenReason(rect, clip, input.overlayRects);
  const visible = hiddenBecause === undefined;
  return {
    rect,
    clip,
    visible,
    hiddenBecause,
    key: [rect.x, rect.y, rect.width, rect.height, visible ? 1 : 0].map(String).join(":"),
    reason: input.reason,
    sampledAtMs: input.sampledAtMs,
  };
}

function roundCoordinate(value: number): number {
  return Math.round(value * GEOMETRY_ROUNDING_FACTOR) / GEOMETRY_ROUNDING_FACTOR;
}

/** Whether two rectangles share any area. Touching edges do not count. */
function rectsOverlap(first: PaneRect, second: PaneRect): boolean {
  const overlap = intersectRects(first, second);
  return overlap.width > 0 && overlap.height > 0;
}

function isBelowMinimumEdge(rect: PaneRect): boolean {
  return rect.width < MINIMUM_VISIBLE_EDGE_PX || rect.height < MINIMUM_VISIBLE_EDGE_PX;
}

function readHiddenReason(
  rect: PaneRect,
  clip: PaneRect,
  overlayRects: readonly PaneRect[],
): PaneGeometryHiddenReason | undefined {
  if (isBelowMinimumEdge(rect) || isBelowMinimumEdge(clip)) {
    return "below-minimum-edge";
  }
  return overlayRects.some((overlay) => rectsOverlap(overlay, rect)) ? "occluded" : undefined;
}
