// Two dialogs up at once, and what the register says when one of them closes.
//
// The first case is the one that guards the regression: with a boolean each publisher wrote,
// closing a second dialog published `false` under the first. The assertion is therefore that
// closing publishes what the rest of the register says, not merely `false`.
//
// Publications are collected rather than sampled, because a `false` then `true` would settle
// correctly yet drop `inert` for a frame. The list is the register's moves, so a release that
// leaves another claim standing repeats `true`; the window store dedupes unchanged values.

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

    // The first dialog is still on screen trapping focus; a `false` here drops `inert` and makes
    // everything underneath reachable.
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
    // Strict mode runs an effect's cleanup between its two invocations, and a close followed by
    // an unmount releases twice; a register that underflowed or republished could not be called
    // safely from a cleanup.
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.release(FIRST_DIALOG);
    claims.release(FIRST_DIALOG);

    expect(published).toStrictEqual([true, false]);
  });

  it("leaves every other claim alone when a stale release arrives", () => {
    // The broken shape let a caller that had given up its claim clear everybody else's.
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
    // Makes every list above a claim about the holds and releases that produced it, not about a
    // register that publishes on construction.
    const { claims, published } = registerUnderTest();

    expect(published).toStrictEqual([]);
    expect(claims.heldClaimCount).toBe(0);
  });
});
