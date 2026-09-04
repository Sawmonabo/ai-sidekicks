// Which running animations are allowed to arm a frame loop.
//
// Two bounds, and every case below is one of them going wrong in the expensive
// direction or in the silent one. Too permissive and a loading skeleton's opacity
// pulse spends a frame per pane forever; too strict and a pane sits at coordinates it
// abandoned for the whole of an animation, which nothing on screen reports.

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  couldAnimationMove,
  KEYFRAME_TIMING_KEYS,
  normalizeAnimatedPropertyName,
  PAINT_ONLY_ANIMATED_PROPERTIES,
} from "./animation-motion.js";
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

// The two closed sets themselves, read as data rather than through the predicate.
//
// They were module-level `Set` singletons, which `apps/desktop/AGENTS.md` rejects:
// a `ReadonlySet` annotation restricts the BINDING and leaves the collection under
// it mutable for the life of the process, and a container built at module load is
// state where the module holds a constant. As tuples the declaration is frozen by
// the compiler and the union is derived from it, so the properties the predicate
// depends on become checkable here rather than assumed.
describe("the two closed sets the filter is built from", () => {
  it("keeps every element type a literal, so a typo cannot widen the set to `string`", () => {
    // The type-level half. `as const` is what makes each tuple's element type the
    // closed union of its own members; without it both widen to `string[]` and every
    // downstream derivation silently admits any string at all.
    expectTypeOf<(typeof KEYFRAME_TIMING_KEYS)[number]>().not.toEqualTypeOf<string>();
    expectTypeOf<(typeof PAINT_ONLY_ANIMATED_PROPERTIES)[number]>().not.toEqualTypeOf<string>();
    expectTypeOf<(typeof KEYFRAME_TIMING_KEYS)[number]>().toExtend<string>();
    expectTypeOf<(typeof PAINT_ONLY_ANIMATED_PROPERTIES)[number]>().toExtend<string>();
  });

  it("normalizes every entry to a distinct name within its own set", () => {
    // A duplicate is how a set silently shrinks: two spellings that normalize to one
    // name read as twenty-six entries and cover twenty-five properties.
    for (const closedSet of [PAINT_ONLY_ANIMATED_PROPERTIES, KEYFRAME_TIMING_KEYS]) {
      const normalized = closedSet.map((name) => normalizeAnimatedPropertyName(name));
      expect(new Set(normalized).size).toBe(closedSet.length);
    }
  });

  it("keeps the two sets disjoint, which is what lets the predicate ask both", () => {
    // `affectsLayoutOrPosition` excludes a key that is in EITHER set. A name in both
    // would be an entry whose removal from one changes nothing, which is how a set
    // stops being the declaration of anything.
    const timingNames = KEYFRAME_TIMING_KEYS.map((key) => normalizeAnimatedPropertyName(key));
    for (const property of PAINT_ONLY_ANIMATED_PROPERTIES) {
      expect(timingNames).not.toContain(normalizeAnimatedPropertyName(property));
    }
  });

  it("negative control: the normalization actually folds the two authored spellings", () => {
    // Without this, a normalizer that returned its argument unchanged would satisfy
    // both cases above — and would then answer `false` for every camel-cased key
    // `getKeyframes()` reports, which is the undiscriminated reading again.
    expect(normalizeAnimatedPropertyName("background-color")).toBe(
      normalizeAnimatedPropertyName("backgroundColor"),
    );
    expect(normalizeAnimatedPropertyName("inline-size")).not.toBe(
      normalizeAnimatedPropertyName("opacity"),
    );
  });
});
