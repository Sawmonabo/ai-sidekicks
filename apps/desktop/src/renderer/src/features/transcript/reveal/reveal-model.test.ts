// The engine's two closed sets, pinned where they are declared. `toStrictEqual` over the spread
// arrays pins membership and order, so widening either set is an edit here rather than a silent
// new member in a consumer's `switch`.

import { describe, expect, it } from "vitest";

import { REVEAL_DIAGNOSTIC_KINDS, REVEAL_ENGINE_STATES } from "./reveal-model.js";

describe("the reveal engine's published vocabulary", () => {
  it("declares its states and diagnostics closed", () => {
    expect([...REVEAL_ENGINE_STATES]).toStrictEqual([
      "idle",
      "streaming",
      "catching-up",
      "settled",
    ]);
    expect([...REVEAL_DIAGNOSTIC_KINDS]).toStrictEqual([
      "out-of-band-source-change",
      "transition-failed",
      "checkpoint-dropped",
    ]);
  });
});
