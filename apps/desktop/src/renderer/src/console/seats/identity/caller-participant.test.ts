// The one composition of "which participant is this window".
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
import { callerParticipantIdentityFrom } from "./caller-participant.js";

/** The port's own refusal for this operation, built by the module that mints them. */
const IDENTITY_REFUSED = growthUnavailable("callerParticipantRead");

describe("the caller-participant narrowing", () => {
  it("answers the identifier on the served arm", () => {
    expect(
      callerParticipantIdentityFrom({
        status: "served",
        value: { participantId: "participant-1" },
      }),
    ).toBe("participant-1");
  });

  it("hands the port's own refusal back untouched on the refusing arm", () => {
    expect(callerParticipantIdentityFrom(IDENTITY_REFUSED)).toBe(IDENTITY_REFUSED);
  });
});
