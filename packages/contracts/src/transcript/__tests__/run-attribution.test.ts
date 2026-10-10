// The run a payload names, which files every transcript row under its run group.
import { describe, expect, it } from "vitest";

import { transcriptRunIdOf } from "../run-attribution.js";

const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";

describe("reading the run a payload names", () => {
  it("answers on either spelling that names a run", () => {
    // `runId` on every run-attributed event kind, `targetRunId` on interventions.
    expect(transcriptRunIdOf({ runId: RUN_ONE })).toBe(RUN_ONE);
    expect(transcriptRunIdOf({ targetRunId: RUN_ONE })).toBe(RUN_ONE);
  });

  it("never files a child's rows in its parent's run group", () => {
    // A payload carrying only the parent's id names no run, rather than the parent's.
    expect(transcriptRunIdOf({ parentRunId: RUN_ONE })).toBeUndefined();
    // Beside its own run, the row's own id wins.
    expect(transcriptRunIdOf({ runId: RUN_TWO, parentRunId: RUN_ONE })).toBe(RUN_TWO);
  });

  it("refuses a value that is not a non-empty string, and an absent payload", () => {
    expect(transcriptRunIdOf({ runId: "" })).toBeUndefined();
    expect(transcriptRunIdOf({ runId: 7 })).toBeUndefined();
    expect(transcriptRunIdOf(undefined)).toBeUndefined();
  });
});
