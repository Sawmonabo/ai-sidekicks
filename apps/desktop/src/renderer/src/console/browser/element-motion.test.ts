// The DOM seams an overlay's movement is read through.
//
// Each of the four is a claim a naive reading gets wrong: a resize observer that is
// never disconnected outlives its overlay; a motion listener attached to the overlay
// hears its ancestors' transitions not at all; a sibling's animation moves nothing;
// and a paused animation is not motion. Every clean case below has the control that
// fails without the rule.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasRunningMotion,
  observeElementResize,
  observeMotionStarts,
  sharesMotionWith,
} from "./element-motion.js";
import { installFakeResizeObserver } from "./element-motion.test-support.js";

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
