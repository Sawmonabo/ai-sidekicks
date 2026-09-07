// Two surfaces up at once, and what the register says when one of them closes.
//
// THE CASE THAT WOULD HAVE CAUGHT THE DEFECT is the first one. While the frame's
// guard was a boolean each publisher wrote, a second dialog closing published `false`
// under the first, and the background came back structurally reachable behind a
// dialog still on screen. So the assertion here is not "closing publishes `false`" —
// that was true of the broken shape too — but "closing publishes what the REST of the
// register says", which is a different claim and the only one that bites.
//
// THE PUBLICATIONS ARE COLLECTED RATHER THAN SAMPLED. What the frame renders is the
// sequence, not the final value: a register that published `false` and then `true`
// again would settle correctly and still have dropped `inert` for a frame. Every case
// asserts the whole list.
//
// AND THE LIST IS THE REGISTER'S MOVES, NOT THE CELL'S. This register speaks whenever
// it MOVED — so a release that leaves another claim standing repeats `true`, which is
// the register saying the answer it has now rather than a claim that anything changed.
// Whether an unchanged value reaches a subscriber is the store's own comparison, one
// layer up, and `frame-store.test.ts` is where that is asserted.

import { describe, expect, it } from "vitest";

import { ModalSurfaceClaims } from "./modal-surface-claims.js";

/** The two window-scoped overlays that can be up at once, named as the console has them. */
const SIGN_IN_CARD = "the-sign-in-card";
const ONBOARDING_WALKTHROUGH = "the-onboarding-walkthrough";

/** A register and the flags it published, in order. */
function registerUnderTest(): {
  readonly claims: ModalSurfaceClaims;
  readonly published: boolean[];
} {
  const published: boolean[] = [];
  return {
    claims: new ModalSurfaceClaims((isAnyHeld) => {
      published.push(isAnyHeld);
    }),
    published,
  };
}

describe("the modal-surface register — one claim per surface", () => {
  it("keeps the guard armed when one of two overlapping surfaces closes", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(SIGN_IN_CARD);
    claims.hold(ONBOARDING_WALKTHROUGH);
    claims.release(ONBOARDING_WALKTHROUGH);

    // The sign-in card is still on screen trapping focus. A `false` here is the
    // defect: the frame drops `inert` and the rail, the route surface, and every
    // control underneath become reachable by structural navigation.
    expect(published).toStrictEqual([true, true, true]);
    expect(claims.heldClaimCount).toBe(1);
  });

  it("disarms it only when the last surface closes", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(SIGN_IN_CARD);
    claims.hold(ONBOARDING_WALKTHROUGH);
    claims.release(ONBOARDING_WALKTHROUGH);
    claims.release(SIGN_IN_CARD);

    expect(published).toStrictEqual([true, true, true, false]);
    expect(claims.heldClaimCount).toBe(0);
  });

  it("costs nothing to release a claim twice", () => {
    // Strict mode invokes an effect's cleanup between its two invocations, and a
    // close followed by an unmount releases the same claim twice. A register that
    // underflowed or republished here would be a register no cleanup could call
    // safely.
    const { claims, published } = registerUnderTest();

    claims.hold(SIGN_IN_CARD);
    claims.release(SIGN_IN_CARD);
    claims.release(SIGN_IN_CARD);

    expect(published).toStrictEqual([true, false]);
  });

  it("leaves every other claim alone when a stale release arrives", () => {
    // The one operation the broken shape performed and this one cannot express: a
    // caller that has already given up its claim clearing everybody else's.
    const { claims, published } = registerUnderTest();

    claims.hold(SIGN_IN_CARD);
    claims.release(ONBOARDING_WALKTHROUGH);

    expect(published).toStrictEqual([true]);
    expect(claims.heldClaimCount).toBe(1);
  });

  it("says nothing when the same surface holds twice", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(SIGN_IN_CARD);
    claims.hold(SIGN_IN_CARD);

    expect(published).toStrictEqual([true]);
    expect(claims.heldClaimCount).toBe(1);
  });

  it("control: a register nobody has claimed publishes nothing at all", () => {
    // Which is what makes every list above a claim about the holds and releases that
    // produced it, rather than about a register that publishes on construction.
    const { claims, published } = registerUnderTest();

    expect(published).toStrictEqual([]);
    expect(claims.heldClaimCount).toBe(0);
  });
});
