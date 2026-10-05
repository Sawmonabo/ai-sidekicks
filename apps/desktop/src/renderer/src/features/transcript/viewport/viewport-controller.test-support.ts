// Rows, calm reconcile conditions, an attached controller and the layout stub shared by the
// viewport's suites, so their claims stay about the same reconcile and the same box.

import { vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import type { ViewportRow } from "./viewport-snapshot.js";
import { ViewportController } from "./viewport-controller.js";

/** `count` rows, optionally all under one run group. */
export function syntheticRows(count: number, runGroupKey?: string): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `${runGroupKey ?? "row"}-${String(index)}`,
    parentKey: runGroupKey,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Reconcile conditions with nothing in flight — no turn, no reveal draining. */
export const CALM: { hasActiveTurn: boolean; isRevealDraining: boolean } = {
  hasActiveTurn: false,
  isRevealDraining: false,
};

/** Rows named by key, for the cases about which END of the window a set grew at. */
export function rowsFrom(keys: readonly string[]): readonly ViewportRow[] {
  return keys.map((key) => ({ key, parentKey: undefined, rootCursor: `cursor-${key}` }));
}

/** A controller attached to a detached element, with the clock its cases advance. */
export function attachedController(): {
  controller: ViewportController;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}

/** The box height the laid-out viewport reports. */
export const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

/** The content height the laid-out viewport reports, taller than the box. */
export const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;

/**
 * Give every element a laid-out box for one case: `happy-dom` reports zero, and the virtualizer
 * treats a zero outer size as no range at all. Content taller than the box comes too unless
 * `scrollable` is false, because the chokepoint clamps every write to
 * `scrollHeight - clientHeight`.
 */
export function withLaidOutViewport(options: { readonly scrollable?: boolean } = {}): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  if (options.scrollable ?? true) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      LAID_OUT_CONTENT_HEIGHT_PX,
    );
  }
}
