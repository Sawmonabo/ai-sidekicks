// Which running animations are allowed to arm a frame loop.
//
// Two bounds, and every case below is one of them going wrong in the expensive
// direction or in the silent one. Too permissive and a loading skeleton's opacity
// pulse spends a frame per pane forever; too strict and a pane sits at coordinates it
// abandoned for the whole of an animation, which nothing on screen reports.

import { afterEach, describe, expect, it } from "vitest";

import { couldAnimationMove } from "./animation-motion.js";
import { fakeAnimation, fakeAnimationOf } from "./element-motion.test-support.js";

const attachedRoots: Element[] = [];

function attachedElement(position?: string): HTMLElement {
  const element = document.createElement("div");
  if (position !== undefined) {
    element.style.position = position;
  }
  document.body.append(element);
  attachedRoots.push(element);
  return element;
}

/** The caller's containment vocabulary, as `element-motion.ts` supplies it. */
function carriedBy(subject: Element): (target: Element) => boolean {
  return (target) => subject.contains(target) || target.contains(subject);
}

/** Nothing carries the subject, so every case is decided by the other bound. */
const CARRIES_NOTHING = (): boolean => false;

afterEach(() => {
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
});

describe("couldAnimationMove — what is being animated", () => {
  it("refuses an animation that only paints", () => {
    const skeleton = attachedElement();
    expect(
      couldAnimationMove(
        fakeAnimationOf({ playState: "running", properties: ["opacity"], target: skeleton }),
        CARRIES_NOTHING,
      ),
    ).toBe(false);
  });

  it("refuses every paint-time property the set names, in either spelling", () => {
    const painted = attachedElement();
    for (const property of ["background-color", "backgroundColor", "boxShadow", "filter"]) {
      expect(
        couldAnimationMove(
          fakeAnimationOf({ playState: "running", properties: [property], target: painted }),
          CARRIES_NOTHING,
        ),
      ).toBe(false);
    }
  });

  it("counts a property that can change a box, in either spelling", () => {
    const moving = attachedElement();
    for (const property of ["transform", "inline-size", "inlineSize", "gap", "font-size"]) {
      expect(
        couldAnimationMove(
          fakeAnimationOf({ playState: "running", properties: [property], target: moving }),
          CARRIES_NOTHING,
        ),
      ).toBe(true);
    }
  });

  it("counts a mixed animation, because one of its properties moves things", () => {
    const moving = attachedElement();
    expect(
      couldAnimationMove(
        fakeAnimationOf({
          playState: "running",
          properties: ["opacity", "transform"],
          target: moving,
        }),
        CARRIES_NOTHING,
      ),
    ).toBe(true);
  });

  it("counts an animation whose effect this build cannot read", () => {
    // The fail-safe arm. "Cannot tell" and "cannot move it" are different answers,
    // and only one of them is cheap to be wrong about.
    expect(couldAnimationMove(fakeAnimation("running"), CARRIES_NOTHING)).toBe(true);
  });

  it("counts an animation whose keyframe reader throws", () => {
    const throwing = {
      playState: "running",
      effect: {
        target: null,
        getKeyframes: () => {
          throw new Error("this build cannot enumerate keyframes");
        },
      },
    } as unknown as Animation;

    expect(couldAnimationMove(throwing, CARRIES_NOTHING)).toBe(true);
  });

  it("negative control: keyframes carrying only timing move nothing", () => {
    // Without this the property test would be satisfied by a reading that counted
    // `offset` and `easing`, which every keyframe carries — and that is the
    // undiscriminated predicate this module replaces, wearing a filter.
    const painted = attachedElement();
    expect(
      couldAnimationMove(
        fakeAnimationOf({ playState: "running", properties: [], target: painted }),
        CARRIES_NOTHING,
      ),
    ).toBe(false);
  });
});

describe("couldAnimationMove — where the animated box sits", () => {
  it("counts an in-flow box the subject does not contain", () => {
    // The case the document-wide reading exists for: a fixed-size sibling animating
    // its width moves the boxes beside it and contains none of them.
    const subject = attachedElement();
    const sibling = attachedElement();
    expect(
      couldAnimationMove(
        fakeAnimationOf({ playState: "running", properties: ["inline-size"], target: sibling }),
        carriedBy(subject),
      ),
    ).toBe(true);
  });

  it("refuses an out-of-flow box beside the subject", () => {
    const subject = attachedElement();
    for (const position of ["absolute", "fixed"]) {
      const overlay = attachedElement(position);
      expect(
        couldAnimationMove(
          fakeAnimationOf({ playState: "running", properties: ["inline-size"], target: overlay }),
          carriedBy(subject),
        ),
      ).toBe(false);
    }
  });

  it("counts an out-of-flow ANCESTOR, which carries the subject with it", () => {
    // The containment half runs first for exactly this: a positioned sheet sliding in
    // moves everything inside it, whatever its own flow is.
    const sheet = attachedElement("fixed");
    const subject = document.createElement("div");
    sheet.append(subject);
    expect(
      couldAnimationMove(
        fakeAnimationOf({ playState: "running", properties: ["transform"], target: sheet }),
        carriedBy(subject),
      ),
    ).toBe(true);
  });

  it("counts an animation that names no target element", () => {
    expect(
      couldAnimationMove(
        fakeAnimationOf({ playState: "running", properties: ["transform"] }),
        CARRIES_NOTHING,
      ),
    ).toBe(true);
  });
});
