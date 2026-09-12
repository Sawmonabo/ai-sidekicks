// The one composition of "which user is this window".
//
// What this file holds is what the SEAT adds and not what it composes. Whether an
// identity read is asked once per subject is `growth-read.test.tsx`'s. What is only
// true here is that the adapter three view families used to write out — port outcome
// in, identifier or refusal out — answers on both arms.
//
// THE REFUSAL IS ASSERTED BY IDENTITY AND NOT BY SHAPE. The whole point of the
// narrowing is that a refusal travels back untouched: a re-minted one would carry the
// same fields and lose the operation and the slate row the port put on it, and only an
// identity comparison can tell those apart.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import { callerUserIdentityFrom } from "./caller-user.js";

/** The port's own refusal for this operation, built by the module that mints them. */
const IDENTITY_REFUSED = growthUnavailable("callerUserRead");

describe("the caller-user narrowing", () => {
  it("answers the identifier on the served arm", () => {
    expect(
      callerUserIdentityFrom({
        status: "served",
        value: { userId: "user-1" },
      }),
    ).toBe("user-1");
  });

  it("hands the port's own refusal back untouched on the refusing arm", () => {
    expect(callerUserIdentityFrom(IDENTITY_REFUSED)).toBe(IDENTITY_REFUSED);
  });
});
