// Two dialogs up at once, and what the register says as they close. Closing the second must not
// publish `false` under the first, and closing the last must, or the window stays `inert`.
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
  it("disarms it only when the last dialog closes", () => {
    const { claims, published } = registerUnderTest();

    claims.hold(FIRST_DIALOG);
    claims.hold(SECOND_DIALOG);
    claims.release(SECOND_DIALOG);
    claims.release(FIRST_DIALOG);

    expect(published).toStrictEqual([true, true, true, false]);
  });
});
