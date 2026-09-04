// The registry's job is to be right about what is on screen NOW.
//
// The cases that matter are the ones a naive registry gets wrong: an overlay that
// animates has moved since it registered, so the registry has to hold readers rather
// than rectangles AND has to say so while the movement is happening; an overlay
// positioned by code after it mounts changes its rectangle without changing its size
// or its animation state, so no observer can see it; and an unmount that does not
// remove has to leave the view hidden rather than visible, because a stuck-hidden
// pane is a bug someone reports and a page painted over a dialog is a hazard nobody
// sees.
//
// The movement cases all end the same way, and that ending is the point: the sampling
// stops. A registry that kept a frame armed after the overlay came to rest would be
// correct about geometry and in breach of the budget that forbids idle CPU.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/index.js";
import { installFakeResizeObserver } from "../primitives/element-resize.test-support.js";
import { fakeAnimationOf, withAnimations } from "./element-motion.test-support.js";
import { OVERLAY_KINDS, PaneOcclusionRegistry } from "./occlusion-registry.js";
import type { PaneRect } from "./pane-geometry.js";

const SOMEWHERE: PaneRect = { x: 0, y: 0, width: 10, height: 10 };

const attachedRoots: Element[] = [];

function attachedPair(): { readonly ancestor: HTMLElement; readonly element: HTMLElement } {
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  ancestor.append(element);
  document.body.append(ancestor);
  attachedRoots.push(ancestor);
  return { ancestor, element };
}

/** One mutable animation reading, so a test can let the motion finish. */
function withPlayState(element: Element, readPlayState: () => AnimationPlayState): void {
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    value: () => [{ playState: readPlayState() } as unknown as Animation],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
});

describe("PaneOcclusionRegistry", () => {
  it("reads each overlay's rectangle at the moment it is asked", () => {
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    let top = 0;
    registry.register("dialog", () => ({ ...SOMEWHERE, y: top }));
    expect(registry.liveRects()).toStrictEqual([{ ...SOMEWHERE, y: 0 }]);
    top = 400;
    expect(registry.liveRects()).toStrictEqual([{ ...SOMEWHERE, y: 400 }]);
  });

  it("omits an overlay whose reader has nothing to report, without dropping it", () => {
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    let measured: PaneRect | undefined = undefined;
    registry.register("toast", () => measured);
    expect(registry.liveRects()).toStrictEqual([]);
    expect(registry.registeredCount).toBe(1);
    measured = SOMEWHERE;
    expect(registry.liveRects()).toStrictEqual([SOMEWHERE]);
  });

  it("removes an overlay only through its own handle, and idempotently", () => {
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const registration = registry.register("popover", () => SOMEWHERE);
    registry.register("popover", () => SOMEWHERE);
    registration.remove();
    registration.remove();
    expect(registry.registeredCount).toBe(1);
  });

  it("announces open and close, so a publisher re-samples without polling", () => {
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const observer = vi.fn();
    const unsubscribe = registry.subscribeToChanges(observer);
    const registration = registry.register("command-palette", () => SOMEWHERE);
    expect(observer).toHaveBeenCalledTimes(1);
    registration.remove();
    expect(observer).toHaveBeenCalledTimes(2);
    registration.remove();
    expect(observer).toHaveBeenCalledTimes(2);
    unsubscribe();
    registry.register("context-menu", () => SOMEWHERE);
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("is per-instance, because an auxiliary window has its own overlays", () => {
    const first = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const second = new PaneOcclusionRegistry({ clock: new ManualClock() });
    first.register("dialog", () => SOMEWHERE);
    expect(second.registeredCount).toBe(0);
    expect(second.liveRects()).toStrictEqual([]);
  });

  it("negative control: an empty registry occludes nothing", () => {
    // Every claim above about removal and isolation would hold against a registry
    // whose `liveRects` returned the empty array unconditionally; this pins that the
    // populated reading is the one that differs.
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    expect(registry.liveRects()).toStrictEqual([]);
    registry.register("image-lightbox", () => SOMEWHERE);
    expect(registry.liveRects()).toHaveLength(1);
  });

  it("enumerates every overlay kind 12.3 names, with no duplicates", () => {
    expect(new Set(OVERLAY_KINDS).size).toBe(OVERLAY_KINDS.length);
    expect(OVERLAY_KINDS).toContain("diagram-lightbox");
  });
});

describe("PaneOcclusionRegistry — source 1, movement the overlay reports itself", () => {
  it("announces a rectangle that positioning code has just moved", () => {
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    const registration = registry.register("popover", () => SOMEWHERE);
    observer.mockClear();

    registration.moved();
    registration.moved();

    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("negative control: a registry that emitted only on open and close reports nothing here", () => {
    // This is the finding itself. A popover positioned after mount changes neither
    // its size nor its animation state, so the ONLY source that can see it is the
    // positioning code, and before this handle existed it had nothing to call.
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const observer = vi.fn();
    const registration = registry.register("popover", () => SOMEWHERE);
    registry.subscribeToChanges(observer);

    registration.remove();
    observer.mockClear();
    registration.moved();

    expect(observer).not.toHaveBeenCalled();
  });
});

describe("PaneOcclusionRegistry — source 2, a size change", () => {
  it("announces each resize delivery and disconnects the observer on remove", () => {
    const resizeObserver = installFakeResizeObserver();
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const { element } = attachedPair();
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    const registration = registry.register("toast", () => SOMEWHERE, element);
    observer.mockClear();

    resizeObserver.deliverAll();
    expect(observer).toHaveBeenCalledTimes(1);

    registration.remove();
    expect(resizeObserver.disconnectCount()).toBe(1);
  });

  it("negative control: an overlay that registered no element arms no observer", () => {
    const resizeObserver = installFakeResizeObserver();
    const registry = new PaneOcclusionRegistry({ clock: new ManualClock() });
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    registry.register("toast", () => SOMEWHERE);
    observer.mockClear();

    resizeObserver.deliverAll();

    expect(observer).not.toHaveBeenCalled();
  });
});

describe("PaneOcclusionRegistry — source 3, motion", () => {
  it("samples per frame while an ancestor animates, then stops on the resting frame", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { ancestor, element } = attachedPair();
    let playState: AnimationPlayState = "idle";
    withPlayState(element, () => "idle");
    withPlayState(ancestor, () => playState);
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    registry.register("dialog", () => SOMEWHERE, element);
    observer.mockClear();
    expect(registry.samplingOverlayCount).toBe(0);

    playState = "running";
    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    expect(registry.samplingOverlayCount).toBe(1);

    clock.runFrame();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(registry.samplingOverlayCount).toBe(1);

    playState = "finished";
    clock.runFrame();
    // The resting frame publishes where the overlay ended up, and is the last one.
    expect(observer).toHaveBeenCalledTimes(2);
    expect(registry.samplingOverlayCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("starts sampling for an overlay that registers mid-animation", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { element } = attachedPair();
    withPlayState(element, () => "running");

    registry.register("image-lightbox", () => SOMEWHERE, element);

    expect(registry.samplingOverlayCount).toBe(1);
  });

  it("cancels an armed frame when the overlay is removed mid-animation", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { element } = attachedPair();
    withPlayState(element, () => "running");
    const registration = registry.register("dialog", () => SOMEWHERE, element);
    expect(clock.pendingFrameCount).toBe(1);

    registration.remove();

    expect(clock.pendingFrameCount).toBe(0);
    expect(registry.samplingOverlayCount).toBe(0);
  });

  it("negative control: a still overlay never arms a frame, and a sibling's motion never wakes it", () => {
    // Two failures in one control. A registry that sampled unconditionally would
    // hold a frame armed for the life of every overlay — the idle-CPU breach — and
    // one that woke on any motion anywhere would sample the whole overlay set every
    // time anything in the window animated.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    withPlayState(element, () => "idle");
    withPlayState(ancestor, () => "idle");
    withPlayState(sibling, () => "running");
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    registry.register("context-menu", () => SOMEWHERE, element);
    observer.mockClear();

    expect(registry.samplingOverlayCount).toBe(0);
    sibling.dispatchEvent(new Event("animationstart", { bubbles: true }));

    expect(registry.samplingOverlayCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
    expect(observer).not.toHaveBeenCalled();
  });

  it("stops listening for motion once the last element-bearing overlay is gone", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { ancestor, element } = attachedPair();
    withPlayState(element, () => "running");
    withPlayState(ancestor, () => "running");
    const registration = registry.register("dialog", () => SOMEWHERE, element);
    registration.remove();

    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));

    expect(clock.pendingFrameCount).toBe(0);
  });
});

// The paint-only bound, reached through the OVERLAY door.
//
// Every read in flight in this console renders the `not-loaded` skeleton, and that
// primitive runs an infinite opacity pulse. So a dialog or a popover holding one is
// the common case rather than a contrived one, and while the overlay-scoped reading
// was unfiltered it armed this registry's frame sampler for as long as the read was
// out — one occlusion change per animation frame, over an animation that cannot move
// a box at all. The document-wide reading was already filtered; this is the same
// bound on the other door, through the same filter function.
describe("PaneOcclusionRegistry — source 3, what is animating", () => {
  /** An overlay holding one running animation over the properties a case names. */
  function overlayAnimating(properties: readonly string[]): {
    readonly ancestor: HTMLElement;
    readonly element: HTMLElement;
    readonly moving: HTMLElement;
  } {
    const { ancestor, element } = attachedPair();
    const moving = document.createElement("div");
    element.append(moving);
    const animation = fakeAnimationOf({ playState: "running", properties, target: moving });
    // The subtree read is what the registry takes, so the animation is reported by
    // the overlay itself; the ancestors report none, which is the shape a skeleton
    // inside a dialog actually has.
    withAnimations(element, [animation]);
    withAnimations(ancestor, []);
    withAnimations(moving, [animation]);
    return { ancestor, element, moving };
  }

  it("arms no frame for an overlay holding a loading skeleton's opacity pulse", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { element } = overlayAnimating(["opacity"]);
    const observer = vi.fn();
    registry.subscribeToChanges(observer);

    registry.register("dialog", () => SOMEWHERE, element);
    observer.mockClear();

    // Registering mid-pulse is the case a dialog opened over a read in flight
    // actually is, and it arms nothing at all.
    expect(registry.samplingOverlayCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
    expect(observer).not.toHaveBeenCalled();
  });

  it("stops on the first frame when a paint-only animation announces itself", () => {
    // The announcement still arms one frame, and that is deliberate: a
    // `transitionrun` fires at the start of the delay phase, so refusing to arm on
    // an announcement the animation reading cannot corroborate yet would drop the
    // overlay's first movement. What the filter buys is that the frame is the LAST
    // one — the loop finds nothing that could move a box and does not re-arm, where
    // unfiltered it re-armed on every frame for as long as the read was out.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { element, moving } = overlayAnimating(["opacity"]);
    const observer = vi.fn();
    registry.subscribeToChanges(observer);
    registry.register("dialog", () => SOMEWHERE, element);
    observer.mockClear();

    moving.dispatchEvent(new Event("animationstart", { bubbles: true }));
    expect(registry.samplingOverlayCount).toBe(1);

    clock.runFrame();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(registry.samplingOverlayCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("negative control: an overlay carrying a real transform animation still samples", () => {
    // Without this, a filter that refused every animation would satisfy the case
    // above and would leave the native view painted over a dialog for the whole of
    // its slide-in — the failure the sampler exists to prevent.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const registry = new PaneOcclusionRegistry({ clock });
    const { element } = overlayAnimating(["transform"]);
    const observer = vi.fn();
    registry.subscribeToChanges(observer);

    registry.register("dialog", () => SOMEWHERE, element);
    observer.mockClear();

    expect(registry.samplingOverlayCount).toBe(1);
    clock.runFrame();
    expect(observer).toHaveBeenCalledTimes(1);
  });
});
