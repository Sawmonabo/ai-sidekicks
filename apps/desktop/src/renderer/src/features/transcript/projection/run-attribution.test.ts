import { describe, expect, it } from "vitest";

import { attributedRunIdOf } from "./run-attribution.js";

const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";

describe("reading the run a payload names", () => {
  it("answers on either attributing spelling the contract lists", () => {
    // `runId` on every run-attributed event kind, `targetRunId` on interventions.
    expect(attributedRunIdOf({ runId: RUN_ONE })).toBe(RUN_ONE);
    expect(attributedRunIdOf({ targetRunId: RUN_ONE })).toBe(RUN_ONE);
  });

  it("a member naming another run names nothing here", () => {
    // A payload carrying ONLY the parent's spelling answers `undefined` rather
    // than the parent's id, so a child's rows are never filed in its parent's run group.
    expect(attributedRunIdOf({ parentRunId: RUN_ONE })).toBeUndefined();
    // And beside its own run, the row's own id wins.
    expect(attributedRunIdOf({ runId: RUN_TWO, parentRunId: RUN_ONE })).toBe(RUN_TWO);
  });

  it("refuses a value that is not a non-empty string, and an absent payload", () => {
    // The member is `unknown`, so the shape is read: an empty string and a number are not ids.
    expect(attributedRunIdOf({ runId: "" })).toBeUndefined();
    expect(attributedRunIdOf({ runId: 7 })).toBeUndefined();
    expect(attributedRunIdOf(undefined)).toBeUndefined();
  });
});
