// The reveal engine's two closed sets, pinned where they are declared.
//
// This case travelled here with the declarations it is about. It was written
// beside the engine because that is where the enumerations lived, and asserting a
// module's own closed set from a neighbour's test file is the shape that goes
// stale: the neighbour is deleted or narrowed, and the only assertion that a
// vocabulary is CLOSED goes with it.
//
// Order is part of the claim in both. The states read as the machine walks them —
// nothing, working, working harder, done — and the diagnostic kinds read in the
// order the engine can raise them. `toStrictEqual` over the spread array pins both
// the membership and the order, so widening either set is an edit here rather than
// a silent new member arriving in a consumer's `switch`.

import { describe, expect, it } from "vitest";

import { REVEAL_DIAGNOSTIC_KINDS, REVEAL_ENGINE_STATES } from "./reveal-vocabulary.js";

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
