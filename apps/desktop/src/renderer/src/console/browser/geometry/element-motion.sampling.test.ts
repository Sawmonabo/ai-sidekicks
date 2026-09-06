// What one source costs once it reaches the observer: a frame loop that stops, and a
// budget at rest.
//
// The sources themselves are `element-motion.position-observer.test.ts`'s. This file is
// about the sampling that follows one — because a position observer left armed on every
// mounted pane is only affordable if all three of these hold: it samples once a frame
// while something is really moving and stops on the resting frame; it arms nothing at
// all when the only thing on the page is a loading skeleton pulsing its opacity; and a
// burst of attribute mutations costs one reading rather than one each.
//
// It carries a `ManualClock` for that reason: a frame loop is only assertable against a
// clock a test advances, and a real one would make every case here a race.
//
// The last case is the disposer, which is the same budget stated as a teardown: an
// observer that left a frame armed mid-animation would keep sampling a pane React has
// dropped.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { installFakeResizeObserver } from "../../primitives/element-resize.test-support.js";
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
    // The finding. A rail collapsing beside the pane is neither an ancestor nor a
    // descendant, and a flex line whose boxes keep their sizes reports no resize
    // anywhere — so the containment test this arm used to run answered "no" and the
    // pane's rectangle went unread for the whole animation.
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
    // Still animating, so the next frame is armed: the sibling is mid-collapse and
    // the element is somewhere between where it was and where it is going.
    expect(clock.pendingFrameCount).toBe(1);

    motion.settle();
    clock.runFrame();
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("arms on an animation nothing announced, at the first invalidation after it starts", async () => {
    // The finding. `element.animate()` fires neither `transitionrun` nor
    // `animationstart` — both are CSS vocabularies — and a transform animation on a
    // constant-size box writes no class, no style attribute, no size, and no child
    // list. Sources 1 through 4 hear nothing, so the sampler never armed and the
    // native view sat at coordinates the pane had abandoned for the whole animation.
    installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
    withAnimations(element, []);
    withAnimations(ancestor, []);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock, onMove });
    expect(clock.pendingFrameCount).toBe(0);

    // Exactly what `element.animate()` leaves behind: a running animation in the
    // document reading, and no event raised anywhere.
    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    expect(clock.pendingFrameCount).toBe(0);

    // The class the surface wrote when it decided to animate — source 4, and the
    // moment source 5 reads the animations.
    ancestor.className = "is-collapsing";
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    // Still running, so the loop continues from its own reading rather than from a
    // duration this module was told about.
    expect(clock.pendingFrameCount).toBe(1);

    motion.settle();
    clock.runFrame();
    // And it disarms where the element came to rest, which is the loop's own rule
    // and not a second one paired with the arm.
    expect(clock.pendingFrameCount).toBe(0);
    detach();
  });

  it("negative control: an invalidation with nothing animating arms no frame", async () => {
    // Without it the case above would pass against an observer that armed a frame on
    // every invalidation — a loop the idle-CPU budget forbids, running for the life
    // of the pane after one class write.
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
    // The finding, in its non-animated shape. A width written straight onto a
    // sibling fires no `transitionrun` and no `animationstart`, so the frame sampler
    // never arms; and the sibling, this element, and the ancestor holding both keep
    // the sizes they had, so no size observer fires either. The element moved and
    // every other source in this module says nothing happened.
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
    // Why the watch is rooted at the outermost ancestor. A fixed-size box beside the
    // deck moves the pane exactly as one beside the pane does, and a subtree rooted
    // at the element's own parent contains neither that box nor its mutation.
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
    // The budget this arm has to hold. Every call above reads a rectangle and a
    // clipping-ancestor walk synchronously, so a per-mutation invalidation would turn
    // one class-driven relayout into fifty forced layouts. The observer delivers one
    // callback per delivery turn carrying every record queued in it, which is what
    // makes the burst free.
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
    // The filter is what keeps a document-wide watch affordable. Without it every
    // `aria-expanded` toggle and every `data-` flag the console writes would take a
    // rectangle reading, on a subtree that is the whole document body.
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
    // The finding, measured where it costs: a skeleton's infinite opacity animation
    // used to arm the sampler on install and re-arm it on every frame it ran, so the
    // pane's geometry was read once a frame for as long as anything was loading.
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
    // Without it the case above would pass against an observer that had stopped
    // sampling document motion at all, which is the defect this arm exists for.
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
    // The idle-CPU budget. A standing frame loop would satisfy every clean case above
    // and would also spend a frame per pane forever on a console sitting still.
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
