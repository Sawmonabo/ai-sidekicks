// What one source costs once it reaches the observer, so a position observer can stay armed on
// every mounted pane: one sample per frame while something really moves, stopping on the resting
// frame; nothing armed for a loading skeleton's opacity pulse; and a burst of attribute mutations
// costing one reading. The sources are `element-motion.position-observer.test.ts`'s. A
// `ManualClock` drives it, since a frame loop is only assertable against a clock the test advances.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { observeElementPosition } from "./element-motion.js";
import {
  attachedPair,
  detachAttachedRoots,
  fakeAnimation,
  fakeAnimationOf,
  movingAnimation,
  settleMutationRecords,
  trackAttachedRoot,
  withAnimations,
  withDocumentAnimations,
} from "./element-motion.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  withDocumentAnimations(undefined);
  detachAttachedRoots();
});

describe("observeElementPosition — the frame loop it arms, and what that costs", () => {
  it("samples once a frame while an ancestor animates, then stops on the resting frame", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    const motion = movingAnimation();
    withAnimations(element, []);
    withAnimations(ancestor, [motion.animation]);
    const onMove = vi.fn();

    // Armed mid-animation, so the loop starts at arm time rather than at a start event.
    const detach = observeElementPosition({ element, clock, onMove });
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(clock.pendingFrameCount).toBe(1);

    motion.settle();
    clock.runFrame();
    // The resting frame reports where the pane ended up, and is the last one.
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("samples a fixed-size sibling's motion, which carries the element without containing it", () => {
    // A rail collapsing beside the pane is neither an ancestor nor a descendant and reports no
    // resize, so a containment test would have left the rectangle unread for the whole animation.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    const motion = movingAnimation();
    withAnimations(element, []);
    withAnimations(ancestor, []);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });
    expect(clock.pendingFrameCount).toBe(0);

    withDocumentAnimations([motion.animation]);
    sibling.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();
    expect(onMove).toHaveBeenCalledTimes(1);
    // Still animating, so the next frame is armed.
    expect(clock.pendingFrameCount).toBe(1);

    motion.settle();
    clock.runFrame();
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("arms on an animation nothing announced, at the first invalidation after it starts", async () => {
    // `element.animate()` fires neither `transitionrun` nor `animationstart`, and a transform
    // animation on a constant-size box writes no class, style, size or child list, so the
    // sampler would never arm and the native view would stay at abandoned coordinates.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    withAnimations(element, []);
    withAnimations(ancestor, []);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });
    expect(clock.pendingFrameCount).toBe(0);

    // What `element.animate()` leaves behind: a running animation and no event anywhere.
    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    expect(clock.pendingFrameCount).toBe(0);

    // The class write is source 4, and the moment source 5 reads the animations.
    ancestor.className = "is-collapsing";
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    // Still running, so the loop continues from its own reading rather than a known duration.
    expect(clock.pendingFrameCount).toBe(1);

    motion.settle();
    clock.runFrame();
    // It disarms where the element came to rest, by the loop's own rule.
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("negative control: an invalidation with nothing animating arms no frame", async () => {
    // Without it the case above would pass against an observer that armed a frame on every
    // invalidation, a loop the idle-CPU budget forbids.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    withAnimations(element, []);
    withAnimations(ancestor, []);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });
    ancestor.className = "is-collapsing";
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalled();
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("reports a fixed-size sibling resized in one step, which animates nothing", async () => {
    // A width written straight onto a sibling fires no `transitionrun` or `animationstart`, and
    // the sibling, this element and the ancestor keep their sizes, so no size observer fires.
    installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    sibling.style.width = "240px";
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("reports an instant resize beside an ANCESTOR, not only beside the element", async () => {
    // Why the watch is rooted at the outermost ancestor: a fixed-size box beside the pane layout
    // moves the pane as one beside the pane does, and a subtree rooted at the parent holds neither.
    installFakeResizeObserver();
    const { element } = attachedPair();
    const ancestorSibling = document.createElement("div");
    document.body.append(ancestorSibling);
    trackAttachedRoot(ancestorSibling);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    ancestorSibling.className = "meridian-rail meridian-rail--collapsed";
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("costs one reading for a burst of attribute mutations, not one per mutation", async () => {
    // The budget: each call reads a rectangle and a clipping-ancestor walk synchronously, so a
    // per-mutation invalidation would turn one relayout into fifty forced layouts. One callback
    // per delivery turn carries every queued record.
    installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    for (let mutation = 0; mutation < 50; mutation += 1) {
      sibling.className = `meridian-rail meridian-rail--step-${mutation}`;
    }
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("negative control: an attribute outside the layout filter moves nothing", async () => {
    // The filter keeps a document-wide watch affordable: without it every `aria-expanded` toggle
    // and `data-` flag would take a rectangle reading.
    installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    sibling.setAttribute("aria-expanded", "true");
    sibling.setAttribute("data-pane-kind", "browser");
    await settleMutationRecords();

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });

  it("starts sampling when an ancestor's motion begins after it was armed", () => {
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    withAnimations(element, []);
    withAnimations(ancestor, []);
    const onMove = vi.fn();
    const detach = observeElementPosition({ element, clock, onMove });
    expect(clock.pendingFrameCount).toBe(0);

    withAnimations(ancestor, [fakeAnimation("running")]);
    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));

    expect(clock.pendingFrameCount).toBe(1);
    detach();
  });

  it("stays idle at rest while a loading skeleton pulses somewhere on the page", () => {
    // A skeleton's infinite opacity animation would arm the sampler on install and re-arm it every
    // frame, reading the pane's geometry once a frame for as long as anything loads.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { element } = attachedPair();
    const skeleton = document.createElement("div");
    document.body.append(skeleton);
    trackAttachedRoot(skeleton);
    withAnimations(element, []);
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["opacity"], target: skeleton }),
    ]);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });

    expect(clock.pendingFrameCount).toBe(0);
    for (let frame = 0; frame < 5; frame += 1) {
      clock.runFrame();
    }
    expect(onMove).not.toHaveBeenCalled();
    expect(clock.pendingCount).toBe(0);
    detach();
  });

  it("negative control: the same skeleton beside a real move still samples the move", () => {
    // Without it the case above would pass against an observer that stopped sampling document
    // motion at all.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    const skeleton = document.createElement("div");
    document.body.append(skeleton);
    trackAttachedRoot(skeleton);
    withAnimations(element, []);
    withAnimations(ancestor, []);
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["opacity"], target: skeleton }),
      fakeAnimationOf({ playState: "running", properties: ["transform"], target: ancestor }),
    ]);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("negative control: nothing moves, so no frame is armed and nothing is sampled", () => {
    // The idle-CPU budget: a standing frame loop would satisfy every clean case above and spend
    // a frame per pane forever.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });
    for (let frame = 0; frame < 5; frame += 1) {
      clock.runFrame();
    }

    expect(onMove).not.toHaveBeenCalled();
    expect(clock.pendingCount).toBe(0);
    detach();
  });

  it("disarms every source on dispose, mid-animation included", async () => {
    const resizeObserver = installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    const motion = movingAnimation();
    withAnimations(element, []);
    withAnimations(ancestor, [motion.animation]);
    const onMove = vi.fn();
    const detach = observeElementPosition({ element, clock, onMove });
    expect(resizeObserver.liveObserverCount()).toBeGreaterThan(0);
    expect(clock.pendingFrameCount).toBe(1);

    detach();

    expect(resizeObserver.liveObserverCount()).toBe(0);
    expect(clock.pendingCount).toBe(0);
    ancestor.insertBefore(document.createElement("div"), element);
    resizeObserver.deliverFor(ancestor);
    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    sibling.style.width = "240px";
    await settleMutationRecords();
    clock.runFrame();
    expect(onMove).not.toHaveBeenCalled();
  });
});
