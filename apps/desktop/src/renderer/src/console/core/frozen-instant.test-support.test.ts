// The frozen start instant, and why it is read rather than parsed.
//
// This suite could not have been written before the stamp had one home: it lived in
// a view family, again inside a sessions suite, and twice more in the `test/console/`
// tiers as `Date.parse("…")`. Nothing could assert across four copies, which is the
// whole reason a moved fixture instant used to move two of them.

import { describe, expect, it } from "vitest";

import { parseInstant } from "./instant.js";
import { FROZEN_START_ISO, frozenStartMilliseconds } from "./frozen-instant.test-support.js";

describe("the frozen start instant", () => {
  it("reads as the epoch milliseconds the console's own reader gives", () => {
    const reading = parseInstant(FROZEN_START_ISO);

    expect(reading.kind).toBe("instant");
    expect(frozenStartMilliseconds()).toBe(
      reading.kind === "instant" ? reading.epochMilliseconds : Number.NaN,
    );
  });

  it("refuses a calendar day that does not exist rather than normalising it", () => {
    // The negative control for the two tiers this hoist retired. Both spelled the
    // stamp `Date.parse(…)`, which answers a NUMBER for February 30 — March 2, one
    // day the wire never named — so a mistyped fixture instant read clean and the
    // captured "last seen" figures described an elapsed time nobody chose. The
    // reader this module goes through refuses instead, and the module raises.
    expect(parseInstant("2026-02-30T10:00:00.000Z").kind).toBe("malformed");
    expect(parseInstant(FROZEN_START_ISO).kind).toBe("instant");
  });
});
