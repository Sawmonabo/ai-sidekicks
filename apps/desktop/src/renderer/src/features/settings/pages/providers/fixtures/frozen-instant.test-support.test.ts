// The frozen start instant, and why it is read rather than parsed.

import { describe, expect, it } from "vitest";

import { parseInstant } from "@renderer/lib/instant.js";
import { FROZEN_START_ISO, frozenStartMilliseconds } from "./frozen-instant.test-support.js";

describe("the frozen start instant", () => {
  it("reads as the epoch milliseconds the console's own reader gives", () => {
    const reading = parseInstant(FROZEN_START_ISO);

    expect(reading.kind).toBe("instant");
    expect(frozenStartMilliseconds()).toBe(
      reading.kind === "instant" ? reading.epochMilliseconds : Number.NaN,
    );
  });

  it("refuses a calendar day that does not exist rather than normalizing it", () => {
    // Negative control: `Date.parse(…)` answers a number for February 30 (March 2, a day the
    // wire never named), so a mistyped fixture instant would read clean. The reader this module
    // goes through refuses, and the module raises.
    expect(parseInstant("2026-02-30T10:00:00.000Z").kind).toBe("malformed");
    expect(parseInstant(FROZEN_START_ISO).kind).toBe("instant");
  });
});
