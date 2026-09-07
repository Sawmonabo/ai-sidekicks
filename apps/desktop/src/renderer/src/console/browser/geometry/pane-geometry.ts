// Where the native view is allowed to be, and when it has to get out of the way.
//
// `Spec-023 §Console Design (Meridian)` 12.3, arithmetic half. This module touches no
// DOM and schedules nothing: it is the pure computation that makes a native rectangle
// and a DOM layout look like one application, so every rule it carries has a negative
// control — the clipping-ancestor intersection and the sub-pixel floor on
// `composePaneGeometrySample`, and the yield-to-overlays rule on `PaneOverlaySource`.
// The sampling half — four required invalidation sources, read-now / write-next-frame
// — lives in `geometry-publisher.ts`, which needs a document and cannot be pure.
//
// WHAT IS NOT INVENTED HERE. 12.3 names `browser.setRect` as the publish. That method
// is on `Plan-023 §Console growth slate` row `browser-pane-namespace` with no
// growth-port operation registered for it — the port carries the five navigation verbs
// and the navigation subscription, and nothing else — so the publish target is 12.11's
// HOST SEAM rather than a fabricated method string. Registering the operation belongs
// to the task that lands the namespace.
//
// The two surfaces beside this one: `view-host.ts` is 12.11's host seam — what a
// sample is published TO — and `core/airspace-registry.ts` is the overlay set every
// overlay primitive registers into, reached through the narrow `PaneOverlaySource`
// port so the two do not cycle.

import { type AirspaceRect, type Unsubscribe } from "../../core/index.js";

/** Two-decimal rounding, as the factor: a `toFixed` round trip would be a second
 *  number formatter, which `apps/desktop/AGENTS.md` names a chokepoint breach. */
const GEOMETRY_ROUNDING_FACTOR = 100;

/** The edge length below which there is nothing to show. One and not zero, because a
 *  rectangle rounded to two places can be 0.4 px tall and still be a number. */
const MINIMUM_VISIBLE_EDGE_PX = 1;

/**
 * A rectangle in CSS pixels, viewport-relative, already rounded.
 *
 * The airspace's own rect, aliased rather than re-declared: an overlay rectangle and a
 * pane rectangle are compared against each other by `readHiddenReason` below, and two
 * structurally identical declarations of one shape are two closed sets that agree until
 * somebody widens one.
 */
export type PaneRect = AirspaceRect;

/** Why a sample hides the view: a pane scrolled out of its own scroller, or an
 *  overlay the operator opened. Two different stories, so two members. */
export const PANE_GEOMETRY_HIDDEN_REASONS = ["below-minimum-edge", "occluded"] as const;

export type PaneGeometryHiddenReason = (typeof PANE_GEOMETRY_HIDDEN_REASONS)[number];

/** Why a sample was taken. Carried on every publish, so a diagnostic can name which
 *  of the required sources is the one that is not firing. */
export const GEOMETRY_INVALIDATION_REASONS = [
  "attach",
  "resize-observer",
  "window-resize",
  "document-scroll",
  "layout-mover",
  "theme-change",
  "overlay-change",
] as const;

export type GeometryInvalidationReason = (typeof GEOMETRY_INVALIDATION_REASONS)[number];

/**
 * One reading of where the pane is, and whether the view may be shown there. It
 * travels WHOLE to the host rather than as four numbers, because 12.3 forbids
 * assuming a rectangle is still current after an await: a host handed the sample can
 * compare `key` against what it last applied, and one handed coordinates cannot.
 */
export interface PaneGeometrySample {
  /** The pane's own box, intersected against every clipping ancestor. */
  readonly rect: PaneRect;
  /** The tightest clip that produced it, for a host that masks rather than moves. */
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
 * Round a raw box to the sample's precision.
 *
 * Exported because the rounding factor is part of the ARITHMETIC and there may only be
 * one of it: a caller that read a DOM box and rounded it its own way would produce
 * samples that compare unequal to these for the same rectangle, and the publisher's
 * dedupe is a string comparison over exactly those numbers.
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

function roundCoordinate(value: number): number {
  return Math.round(value * GEOMETRY_ROUNDING_FACTOR) / GEOMETRY_ROUNDING_FACTOR;
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

/** Whether two rectangles share any area. Touching edges do not count. */
function rectsOverlap(first: PaneRect, second: PaneRect): boolean {
  const overlap = intersectRects(first, second);
  return overlap.width > 0 && overlap.height > 0;
}

function isBelowMinimumEdge(rect: PaneRect): boolean {
  return rect.width < MINIMUM_VISIBLE_EDGE_PX || rect.height < MINIMUM_VISIBLE_EDGE_PX;
}

/**
 * What the publisher needs from the overlay registry, and nothing more — a port rather
 * than an import, so the edge runs one way and the two modules do not cycle.
 *
 * The predicate that consults it always resolves the same way: the VIEW yields. An
 * overlay is never dimmed or displaced to make room for a native rectangle painted
 * above the document.
 */
export interface PaneOverlaySource {
  /** Every overlay rectangle on screen right now. */
  liveRects(): readonly PaneRect[];
  /** Fires when an overlay opens or closes, so a publisher re-samples immediately. */
  subscribeToChanges(sink: () => void): Unsubscribe;
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
 * Compose one sample — the whole of 12.3's arithmetic, as a pure function, because a
 * version reachable only by mounting a pane in a real window is one nobody could write
 * a negative control for.
 *
 * The host box is narrowed by EVERY clipping ancestor, because a pane scrolled behind
 * an overflow edge has a valid bounding box that is nowhere the operator can see, and
 * publishing it paints a live web page over the chrome above it. The result hides
 * outright below one pixel on either axis of either the rectangle or the clip: there
 * is nothing left to show, and a hairline of a foreign page bleeding past a boundary
 * reads as a rendering fault rather than as a pane.
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
