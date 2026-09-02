// The registry's job is to be right about what is on screen NOW.
//
// The two cases that matter are the ones a naive registry gets wrong: an overlay that
// animates has moved since it registered, so the registry has to hold readers rather
// than rectangles; and an unmount that does not dispose has to leave the view hidden
// rather than visible, because a stuck-hidden pane is a bug someone reports and a page
// painted over a dialog is a hazard nobody sees.

import { describe, expect, it, vi } from "vitest";

import { OVERLAY_KINDS, PaneOcclusionRegistry } from "./occlusion-registry.js";
import type { PaneRect } from "./pane-geometry.js";

const SOMEWHERE: PaneRect = { x: 0, y: 0, width: 10, height: 10 };

describe("PaneOcclusionRegistry", () => {
  it("reads each overlay's rectangle at the moment it is asked", () => {
    const registry = new PaneOcclusionRegistry();
    let top = 0;
    registry.register("dialog", () => ({ ...SOMEWHERE, y: top }));
    expect(registry.liveRects()).toStrictEqual([{ ...SOMEWHERE, y: 0 }]);
    top = 400;
    expect(registry.liveRects()).toStrictEqual([{ ...SOMEWHERE, y: 400 }]);
  });

  it("omits an overlay whose reader has nothing to report, without dropping it", () => {
    const registry = new PaneOcclusionRegistry();
    let measured: PaneRect | undefined = undefined;
    registry.register("toast", () => measured);
    expect(registry.liveRects()).toStrictEqual([]);
    expect(registry.registeredCount).toBe(1);
    measured = SOMEWHERE;
    expect(registry.liveRects()).toStrictEqual([SOMEWHERE]);
  });

  it("removes an overlay only through its own disposer, and idempotently", () => {
    const registry = new PaneOcclusionRegistry();
    const dispose = registry.register("popover", () => SOMEWHERE);
    registry.register("popover", () => SOMEWHERE);
    dispose();
    dispose();
    expect(registry.registeredCount).toBe(1);
  });

  it("announces open and close, so a publisher re-samples without polling", () => {
    const registry = new PaneOcclusionRegistry();
    const observer = vi.fn();
    const unsubscribe = registry.subscribeToChanges(observer);
    const dispose = registry.register("command-palette", () => SOMEWHERE);
    expect(observer).toHaveBeenCalledTimes(1);
    dispose();
    expect(observer).toHaveBeenCalledTimes(2);
    dispose();
    expect(observer).toHaveBeenCalledTimes(2);
    unsubscribe();
    registry.register("context-menu", () => SOMEWHERE);
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("is per-instance, because an auxiliary window has its own overlays", () => {
    const first = new PaneOcclusionRegistry();
    const second = new PaneOcclusionRegistry();
    first.register("dialog", () => SOMEWHERE);
    expect(second.registeredCount).toBe(0);
    expect(second.liveRects()).toStrictEqual([]);
  });

  it("negative control: an empty registry occludes nothing", () => {
    // Every claim above about removal and isolation would hold against a registry
    // whose `liveRects` returned the empty array unconditionally; this pins that the
    // populated reading is the one that differs.
    const registry = new PaneOcclusionRegistry();
    expect(registry.liveRects()).toStrictEqual([]);
    registry.register("image-lightbox", () => SOMEWHERE);
    expect(registry.liveRects()).toHaveLength(1);
  });

  it("enumerates every overlay kind 12.3 names, with no duplicates", () => {
    expect(new Set(OVERLAY_KINDS).size).toBe(OVERLAY_KINDS.length);
    expect(OVERLAY_KINDS).toContain("diagram-lightbox");
  });
});
