// The DOM seams an element's movement is read through.
//
// Each seam is a claim a naive reading gets wrong: a resize observer that is never
// disconnected outlives its subject; a motion listener attached to the subject hears
// its ancestors' transitions not at all; a sibling's animation moves nothing; a
// paused animation is not motion; and a size observer over the element reports
// nothing whatever when the element is MOVED rather than resized. Every clean case
// below has the control that fails without the rule.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/index.js";
import {
  hasRunningMotion,
  observeElementPosition,
  observeElementResize,
  observeMotionStarts,
  sharesMotionWith,
} from "./element-motion.js";
import { installFakeResizeObserver, settleMutationRecords } from "./element-motion.test-support.js";

function fakeAnimation(playState: AnimationPlayState): Animation {
  return { playState } as unknown as Animation;
}

/** Give one element a Web Animations reading, or take the whole method away. */
function withAnimations(element: Element, animations: readonly Animation[] | undefined): void {
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    value: animations === undefined ? undefined : () => [...animations],
  });
}

const attachedRoots: Element[] = [];

/** `ancestor > element`, both in the live document so events really bubble. */
function attachedPair(): { readonly ancestor: HTMLElement; readonly element: HTMLElement } {
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  ancestor.append(element);
  document.body.append(ancestor);
  attachedRoots.push(ancestor);
  return { ancestor, element };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
});

describe("observeElementResize", () => {
  it("reports every delivery until it is disposed, then disconnects", () => {
    const resizeObserver = installFakeResizeObserver();
    const element = document.createElement("div");
    const onResize = vi.fn();

    const detach = observeElementResize(element, onResize);
    expect(resizeObserver.observedCount()).toBe(1);
    resizeObserver.deliverAll();
    expect(onResize).toHaveBeenCalledTimes(1);

    detach();
    expect(resizeObserver.disconnectCount()).toBe(1);
  });

  it("negative control: a platform with no ResizeObserver arms nothing and reports nothing", () => {
    // Without the guard this line throws rather than degrading, and the whole
    // registry stops registering overlays on that platform.
    vi.stubGlobal("ResizeObserver", undefined);
    const onResize = vi.fn();

    const detach = observeElementResize(document.createElement("div"), onResize);
    detach();

    expect(onResize).not.toHaveBeenCalled();
  });
});

describe("observeMotionStarts", () => {
  it("hears a transition or an animation starting on an ancestor, which never bubbles down", () => {
    const { ancestor, element } = attachedPair();
    const onMotionStart = vi.fn();
    const detach = observeMotionStarts(onMotionStart);

    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    ancestor.dispatchEvent(new Event("animationstart", { bubbles: true }));

    expect(onMotionStart).toHaveBeenCalledTimes(2);
    expect(onMotionStart).toHaveBeenNthCalledWith(1, ancestor);
    detach();
    element.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    expect(onMotionStart).toHaveBeenCalledTimes(2);
  });

  it("negative control: an element-scoped listener would miss exactly that ancestor case", () => {
    // The control is the design decision itself. A listener on the overlay hears its
    // own and its descendants' motion, and an ancestor's transition reaches it never
    // — which is why the module captures at the document instead.
    const { ancestor, element } = attachedPair();
    const heardOnElement = vi.fn();
    element.addEventListener("transitionrun", heardOnElement, { capture: true });

    ancestor.dispatchEvent(new Event("transitionrun", { bubbles: true }));

    expect(heardOnElement).not.toHaveBeenCalled();
  });
});

describe("sharesMotionWith", () => {
  it("is true for the element itself, a descendant, and an ancestor", () => {
    const { ancestor, element } = attachedPair();
    const descendant = document.createElement("span");
    element.append(descendant);

    expect(sharesMotionWith(element, element)).toBe(true);
    expect(sharesMotionWith(element, descendant)).toBe(true);
    expect(sharesMotionWith(element, ancestor)).toBe(true);
  });

  it("negative control: a sibling's motion carries nothing", () => {
    // Without the containment test, one capture-phase listener would wake every
    // overlay in the window on every animation anywhere in it.
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);

    expect(sharesMotionWith(element, sibling)).toBe(false);
  });
});

describe("hasRunningMotion", () => {
  it("reads the element's own subtree and every ancestor up to the root", () => {
    const { ancestor, element } = attachedPair();
    withAnimations(element, []);
    withAnimations(ancestor, [fakeAnimation("running")]);

    expect(hasRunningMotion(element)).toBe(true);
  });

  it("negative control: an animation that is not running is not motion", () => {
    // The whole stop condition rests on this. Reading "has animations" rather than
    // "has running animations" leaves the frame loop armed forever after the first
    // transition an element ever ran, which is the idle-CPU budget's failure.
    const { ancestor, element } = attachedPair();
    withAnimations(element, [fakeAnimation("finished")]);
    withAnimations(ancestor, [fakeAnimation("paused")]);

    expect(hasRunningMotion(element)).toBe(false);
  });

  it("reports stillness on a shim that implements no Web Animations at all", () => {
    const { ancestor, element } = attachedPair();
    withAnimations(element, undefined);
    withAnimations(ancestor, undefined);

    expect(hasRunningMotion(element)).toBe(false);
  });
});

// The three ways a pane moves while its own box stays exactly the shape it was.
//
// Each source below is a case a size observer on the element reports as nothing at
// all: the deck reorders its seats, a sibling shrinks and the flex line redistributes,
// a rail slides in carrying everything inside it. The pane's rectangle is wrong for
// the whole of each of them and the platform never says so on the element itself.
// The last two cases are the budget: nothing is armed at rest, and nothing survives
// the disposer.
describe("observeElementPosition", () => {
  /** One animation whose play state the test moves, read live through the getter. */
  function movingAnimation(): { readonly animation: Animation; settle: () => void } {
    let playState: AnimationPlayState = "running";
    return {
      animation: {
        get playState(): AnimationPlayState {
          return playState;
        },
      } as unknown as Animation,
      settle: () => {
        playState = "finished";
      },
    };
  }

  it("reports a reorder of the element's ancestors, which changes no size", async () => {
    installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    ancestor.insertBefore(document.createElement("div"), element);
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalled();
    detach();
  });

  it("negative control: the element's OWN children changing is content, not placement", async () => {
    // Watching the element's child list instead of its ancestors' would fire on every
    // render of whatever the pane contains and never once on the deck reordering it.
    installFakeResizeObserver();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    element.append(document.createElement("span"));
    await settleMutationRecords();

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });

  it("reports a sibling's relayout, which the platform reports on the ancestor", () => {
    // A sibling that shrinks moves this element and resizes neither it nor, in the
    // reading a naive observer takes, anything else. What actually changes is the
    // ancestor's own content box, which is why the ancestors are what is observed.
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(ancestor);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("negative control: the element's own size belongs to the other seam", () => {
    // `observeElementResize` is armed over the host separately and reports
    // `resize-observer`. If this arm also claimed it, one relayout would be counted
    // as two different facts and the diagnostic reason would stop meaning anything.
    const resizeObserver = installFakeResizeObserver();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(element);

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });

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

  it("disarms all three sources on dispose, mid-animation included", async () => {
    const resizeObserver = installFakeResizeObserver();
    const clock = new ManualClock();
    const { ancestor, element } = attachedPair();
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
    await settleMutationRecords();
    clock.runFrame();
    expect(onMove).not.toHaveBeenCalled();
  });
});
