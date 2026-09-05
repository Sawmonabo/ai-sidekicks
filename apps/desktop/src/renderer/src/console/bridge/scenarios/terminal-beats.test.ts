// The terminal scenario's base instant, stated twice and held to one value.
//
// `terminal-beats.ts` declares the instant the frozen clock reports at tick zero as
// TEXT — what the wire carries — and again as a NUMBER the tick arithmetic adds to.
// It does that rather than deriving the second from the first at module scope,
// because a stamp read with `Date.parse` is read in the HOST's zone the moment its
// spelling loses its `Z`, which turns a scenario into a different scenario on a
// machine east of London. The cost of stating it twice is that the two can drift;
// this file is what makes that cost zero, and it compares them through the console's
// own reader rather than through a second parse of its own.

import { describe, expect, it } from "vitest";

import { parseInstant } from "../../core/index.js";
import {
  TERMINAL_SCENARIO_STARTED_AT_ISO,
  TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS,
} from "./terminal-beats.js";

describe("the terminal scenario's base instant", () => {
  it("spells one instant two ways", () => {
    expect(parseInstant(TERMINAL_SCENARIO_STARTED_AT_ISO).epochMilliseconds).toBe(
      TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS,
    );
  });

  it("negative control: a neighbouring instant does not satisfy the same comparison", () => {
    // Without this the case above would pass over any pair a future edit happened to
    // leave equal, including the `undefined === undefined` a malformed text produces.
    expect(parseInstant("2026-01-01T16:41:00.000Z").epochMilliseconds).not.toBe(
      TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS,
    );
    expect(parseInstant(TERMINAL_SCENARIO_STARTED_AT_ISO).kind).toBe("instant");
  });
});
