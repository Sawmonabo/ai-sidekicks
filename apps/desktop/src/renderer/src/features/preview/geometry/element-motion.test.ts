// The DOM seams an element's movement is read through, one predicate at a time. Each is a claim
// a naive reading gets wrong: a listener on the subject never hears an ancestor's transition, a
// sibling's animation moves nothing, a paused animation is not motion, and a loading skeleton's
// opacity pulse is not motion. The composed observer is covered in
// `element-motion.position-observer.test.ts` and the sibling-size wiring in
// `element-motion.content-layout.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasRunningDocumentMotion,
  hasRunningMotion,
  observeMotionStarts,
  sharesMotionWith,
} from "./element-motion.js";
import {
  attachedPair,
  detachAttachedRoots,
  fakeAnimation,
  fakeAnimationOf,
  trackAttachedRoot,
  withAnimations,
  withDocumentAnimations,
} from "./element-motion.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  withDocumentAnimations(undefined);
  detachAttachedRoots();
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
    // A listener on the overlay never hears an ancestor's transition, which is why the module
    // captures at the document.
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
    // Without the containment test, one capture-phase listener would wake every overlay on every
    // animation.
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
    // Reading "has animations" rather than "has running animations" would leave the frame loop
    // armed forever after an element's first transition.
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

describe("hasRunningDocumentMotion", () => {
  it("sees motion no containment test reaches, because it asks the document", () => {
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    withAnimations(element, []);
    withAnimations(ancestor, []);
    withDocumentAnimations([fakeAnimation("running")]);

    expect(hasRunningDocumentMotion(element)).toBe(true);
    // The element-scoped reading of the same instant sees nothing.
    expect(hasRunningMotion(element)).toBe(false);
  });

  it("negative control: an animation that is not running is not motion here either", () => {
    const { element } = attachedPair();
    withDocumentAnimations([fakeAnimation("finished"), fakeAnimation("paused")]);

    expect(hasRunningDocumentMotion(element)).toBe(false);
  });

  it("reports stillness on a shim that implements no Web Animations at all", () => {
    const { element } = attachedPair();
    withDocumentAnimations(undefined);

    expect(hasRunningDocumentMotion(element)).toBe(false);
  });

  it("a loading skeleton's opacity pulse is not motion, however long it runs", () => {
    // Every `not-loaded` skeleton runs an infinite opacity pulse; if it counted, one loading
    // skeleton would keep the position sampler re-arming every frame.
    const { element } = attachedPair();
    const skeleton = document.createElement("div");
    document.body.append(skeleton);
    trackAttachedRoot(skeleton);
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["opacity"], target: skeleton }),
    ]);

    expect(hasRunningDocumentMotion(element)).toBe(false);
  });

  it("a transform on an ancestor is motion, which is what the sampler is for", () => {
    const { ancestor, element } = attachedPair();
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["transform"], target: ancestor }),
    ]);

    expect(hasRunningDocumentMotion(element)).toBe(true);
  });

  it("an in-flow sibling animating its width is motion no containment test reaches", () => {
    // The case the document-wide reading exists for, which an over-eager containment bound would
    // have discarded with the skeleton.
    const { ancestor, element } = attachedPair();
    const sibling = document.createElement("div");
    ancestor.append(sibling);
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["inline-size"], target: sibling }),
    ]);

    expect(hasRunningDocumentMotion(element)).toBe(true);
  });

  it("an out-of-flow box animating its geometry moves no box beside it", () => {
    const { ancestor, element } = attachedPair();
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    ancestor.append(overlay);
    withDocumentAnimations([
      fakeAnimationOf({ playState: "running", properties: ["inline-size"], target: overlay }),
    ]);

    expect(hasRunningDocumentMotion(element)).toBe(false);
  });

  it("negative control: an animation whose effect cannot be read still counts", () => {
    // The fail-safe arm; without it every case above would pass against a predicate that had
    // stopped answering true.
    const { element } = attachedPair();
    withDocumentAnimations([fakeAnimation("running")]);

    expect(hasRunningDocumentMotion(element)).toBe(true);
  });
});
