// The endurance generator's three claims: exact, deterministic, and wire-true.
//
// Each one is load-bearing for a measurement rather than for a rendering, which is
// why they are asserted here and nowhere else:
//
//   • EXACT — an endurance reading names the row count it was taken at. A generator
//     that produced "about ten thousand" would have two runs of one measurement
//     disagreeing for a reason invisible in the number.
//   • DETERMINISTIC — a heap or frame reading is only comparable across runs if the
//     session it was taken over is byte-identical. This is the case that would fail
//     the day someone reached for a random id or a wall clock in here.
//   • WIRE-TRUE — the rows are the same registered events the picker scenarios play,
//     so the reading is taken over the rendering path the product actually has.

import { describe, expect, it } from "vitest";

import { createTranscriptEnduranceFixture } from "./transcript-endurance.test-support.js";
import { findScenarioContractDefects } from "../helpers/scenario-contract-check/contract-check.js";

/** The count the endurance tier measures the ledger at. */
const TEN_THOUSAND_ROWS = 10_000;

/** Small enough to parse every beat through the strict layer in one case. */
const WIRE_TRUTH_ROW_COUNT = 800;

describe("createTranscriptEnduranceFixture", () => {
  it("plays exactly the row count it was asked for", () => {
    expect(createTranscriptEnduranceFixture({ rowCount: TEN_THOUSAND_ROWS }).beats).toHaveLength(
      TEN_THOUSAND_ROWS,
    );
  });

  it("plays exactly the row count for an odd count no run group divides evenly", () => {
    // The negative control for the case above: an exact count that only holds when
    // the budget divides cleanly is not an exact count. 9,997 leaves a remainder the
    // last run group has to absorb.
    expect(createTranscriptEnduranceFixture({ rowCount: 9_997 }).beats).toHaveLength(9_997);
  });

  it("produces a byte-identical session for identical arguments", () => {
    const first = createTranscriptEnduranceFixture({ rowCount: WIRE_TRUTH_ROW_COUNT });
    const second = createTranscriptEnduranceFixture({ rowCount: WIRE_TRUTH_ROW_COUNT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces a different session for a different row count", () => {
    // The negative control for determinism: two equal strings prove nothing if the
    // generator ignores its arguments.
    const smaller = createTranscriptEnduranceFixture({ rowCount: WIRE_TRUTH_ROW_COUNT });
    const larger = createTranscriptEnduranceFixture({ rowCount: WIRE_TRUTH_ROW_COUNT + 8 });
    expect(JSON.stringify(larger)).not.toBe(JSON.stringify(smaller));
  });

  it("scripts only events the daemon can emit", () => {
    expect(
      findScenarioContractDefects([
        createTranscriptEnduranceFixture({ rowCount: WIRE_TRUTH_ROW_COUNT }),
      ]),
    ).toStrictEqual([]);
  });

  it("advances sequence and scenario time monotonically across every beat", () => {
    const { beats } = createTranscriptEnduranceFixture({ rowCount: TEN_THOUSAND_ROWS });
    let previousAtMs = -1;
    for (const [beatIndex, beat] of beats.entries()) {
      expect(beat.event.sequence).toBe(beatIndex + 1);
      expect(beat.atMs).toBeGreaterThan(previousAtMs);
      previousAtMs = beat.atMs;
    }
  });

  it("spreads the rows across run groups, each of which closes", () => {
    const runCount = 12;
    const { beats } = createTranscriptEnduranceFixture({ rowCount: 2_000, runCount });
    const openedRuns = new Set(
      beats.filter((beat) => beat.event.kind === "run.queued").map((beat) => beat.event.sequence),
    );
    const closedRuns = beats.filter((beat) => beat.event.kind === "run.completed");
    expect(openedRuns.size).toBe(runCount);
    expect(closedRuns).toHaveLength(runCount);
  });

  it("refuses a row count too small to give every run group a body", () => {
    expect(() => createTranscriptEnduranceFixture({ rowCount: 20, runCount: 12 })).toThrow(
      RangeError,
    );
  });

  it("accepts the smallest row count that does fit", () => {
    // The negative control for the refusal above: 4 opening beats, plus 12 run groups
    // of 4 lifecycle beats, plus one body row for each of those 12, is 64 — and one
    // row fewer leaves a run group with no body at all.
    expect(() => createTranscriptEnduranceFixture({ rowCount: 64, runCount: 12 })).not.toThrow();
    expect(() => createTranscriptEnduranceFixture({ rowCount: 63, runCount: 12 })).toThrow(
      RangeError,
    );
  });

  it("refuses a run count that is not a whole positive number", () => {
    expect(() => createTranscriptEnduranceFixture({ rowCount: 1_000, runCount: 0 })).toThrow(
      RangeError,
    );
  });

  it("refuses a fractional row count rather than silently flooring it", () => {
    expect(() => createTranscriptEnduranceFixture({ rowCount: 1_000.5 })).toThrow(RangeError);
  });
});
