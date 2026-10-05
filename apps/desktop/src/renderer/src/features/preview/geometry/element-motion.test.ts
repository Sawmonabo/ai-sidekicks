// A pane's native view follows its box, so the position observer has to hear every way the pane
// moves while its own size stays put, and cost nothing at rest: one sample per frame while
// something really moves, stopping on the resting frame; nothing armed for a loading skeleton's
// opacity pulse; one reading for a burst of mutations; every source disarmed on detach. A
// `ManualClock` drives it, since a frame loop is only assertable against a clock the test advances.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { observeElementPosition } from "./element-motion.js";
import {
  attachedPair,
  detachAttachedRoots,
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

/**
 * `root > ancestor > (element, sibling)`, in the live document. The ancestor is fixed-size, so
 * it is never relaid; the sibling is auto-sized, so a text rewrite or nested insertion inside it
 * changes its box and pushes the element across the screen.
 */
function attachedNeighborhood(): {
  readonly ancestor: HTMLElement;
  readonly element: HTMLElement;
  readonly sibling: HTMLElement;
} {
  const root = document.createElement("div");
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  const sibling = document.createElement("div");
  ancestor.append(element, sibling);
  root.append(ancestor);
  document.body.append(root);
  trackAttachedRoot(root);
  return { ancestor, element, sibling };
}

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

  it("samples a fixed-size sibling's motion, which carries the element without holding it", () => {
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

describe("observeElementPosition — the sources that reach it", () => {
  it("reports a sibling's relayout, which the platform reports on the ancestor", () => {
    // A shrinking sibling resizes neither this element nor, to a naive observer, anything else;
    // what changes is the ancestor's content box, which is why ancestors are observed.
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(ancestor);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it(
    "reports an auto-sized sibling growing, which moves the element " +
      "and resizes none of its boxes",
    () => {
      const resizeObserver = installFakeResizeObserver();
      const { element, sibling } = attachedNeighborhood();
      const onMove = vi.fn();

      const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
      // A rewritten text node or nested insertion changes the sibling's box, and no ancestor's.
      resizeObserver.deliverFor(sibling);

      expect(onMove).toHaveBeenCalledTimes(1);
      detach();
    },
  );
});
