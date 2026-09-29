// Two dialogs up at once, and what the register says when one of them closes.
//
// THE CASE THAT WOULD HAVE CAUGHT THE DEFECT is the first one. While the window's
// guard was a boolean each publisher wrote, a second dialog closing published `false`
// under the first, and the background came back structurally reachable behind a
// dialog still on screen. So the assertion here is not "closing publishes `false`" —
// that was true of the broken shape too — but "closing publishes what the REST of the
// register says", which is a different claim and the only one that bites.
//
// THE PUBLICATIONS ARE COLLECTED RATHER THAN SAMPLED. What the window renders is the
// sequence, not the final value: a register that published `false` and then `true`
// again would settle correctly and still have dropped `inert` for a frame. Every case
// asserts the whole list.
//
// AND THE LIST IS THE REGISTER'S MOVES, NOT THE CELL'S. This register speaks whenever
// it MOVED — so a release that leaves another claim standing repeats `true`, which is
// the register saying the answer it has now rather than a claim that anything changed.
// Whether an unchanged value reaches a subscriber is the store's own comparison, one
// layer up, in the window store.

import { describe, expect, it } from "vitest";

import { ModalDialogClaims } from "./modal-dialog-claims.js";

/** Two modal dialogs one window holds at once. */
const FIRST_DIALOG = "the-first-dialog";
const SECOND_DIALOG = "the-second-dialog";

/** A register and the flags it published, in order. */
function registerUnderTest(): {
  readonly claims: ModalDialogClaims;
  readonly published: boolean[];
} {
  const published: boolean[] = [];
  return {
    claims: new ModalDialogClaims((isAnyHeld) => {
      published.push(isAnyHeld);
    }),
    published,
  };
}

describe("the modal dialog register — one claim per dialog", () => {
  it("keeps the guard armed when one of two overlapping dialogs closes", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.hold(SECOND_DIALOG);
    claims.release(SECOND_DIALOG);

    // The first dialog is still on screen trapping focus. A `false` here is the
    // defect: the window drops `inert` and the rail, the screen, and every
    // control underneath become reachable by structural navigation.
    expect(published).toStrictEqual([true, true, true]);
    expect(claims.heldClaimCount).toBe(1);
  });

  it("disarms it only when the last dialog closes", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.hold(SECOND_DIALOG);
    claims.release(SECOND_DIALOG);
    claims.release(FIRST_DIALOG);

    expect(published).toStrictEqual([true, true, true, false]);
    expect(claims.heldClaimCount).toBe(0);
  });

  it("costs nothing to release a claim twice", () => {
    // Strict mode invokes an effect's cleanup between its two invocations, and a
    // close followed by an unmount releases the same claim twice. A register that
    // underflowed or republished here would be a register no cleanup could call
    // safely.
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.release(FIRST_DIALOG);
    claims.release(FIRST_DIALOG);

    expect(published).toStrictEqual([true, false]);
  });

  it("leaves every other claim alone when a stale release arrives", () => {
    // The one operation the broken shape performed and this one cannot express: a
    // caller that has already given up its claim clearing everybody else's.
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.release(SECOND_DIALOG);

    expect(published).toStrictEqual([true]);
    expect(claims.heldClaimCount).toBe(1);
  });

  it("says nothing when the same dialog holds twice", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.hold(FIRST_DIALOG);

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
