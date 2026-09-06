// The order the rows come out in, and the order two reads of one list agree on.
//
// Both claims are about the comparator rather than about any one row, which is why
// they are read together: the first says which key wins, and the second says that the
// keys settle every pair rather than leaving some of them to whatever order the
// enumeration happened to supply.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { phase, run } from "./run-list-projection.test-support.js";
import type { WorkflowRunSnapshot } from "./run-list-rows.js";

describe("row ordering", () => {
  const settled = run({
    workflowRunId: "run-settled",
    state: "completed",
    startedAt: "2026-09-01T12:00:00.000Z",
    phaseStates: [phase({ state: "completed" })],
  });
  const activeOlder = run({
    workflowRunId: "run-active-older",
    startedAt: "2026-09-01T09:00:00.000Z",
  });
  const activeNewer = run({
    workflowRunId: "run-active-newer",
    startedAt: "2026-09-01T11:00:00.000Z",
  });
  const parked = run({
    workflowRunId: "run-parked",
    startedAt: "2026-09-01T08:00:00.000Z",
    phaseStates: [
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Sign-off needed." }),
    ],
  });

  it("puts parked first, then active, then settled — regardless of input order", () => {
    const projection = new RunListProjection([settled, activeOlder, activeNewer, parked]);
    expect(projection.rows.map((row) => row.run.workflowRunId)).toStrictEqual([
      "run-parked",
      "run-active-newer",
      "run-active-older",
      "run-settled",
    ]);
  });

  it("negative control: the input order is not the output order", () => {
    // The case above would pass over a projection that returned its input untouched
    // if the input happened to arrive sorted. It does not here, and this states so.
    const input = [settled, activeOlder, activeNewer, parked];
    const projection = new RunListProjection(input);
    expect(projection.rows.map((row) => row.run.workflowRunId)).not.toStrictEqual(
      input.map((snapshot) => snapshot.workflowRunId),
    );
  });

  it("bands a `suspended` run as parked even when no phase carries park members", () => {
    // An older daemon emits none of the four; the run status still says something is
    // waiting, and dropping such a run into `active` would hide it under the runs
    // that are actually moving.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [] }),
      activeNewer,
    ]);
    expect(projection.rows[0]?.run.workflowRunId).toBe("run-suspended");
    expect(projection.rows[0]?.parkedPhases).toStrictEqual([]);
  });
});

/**
 * Two reads of one list, and the rows that must not move between them.
 *
 * The defect these close: the comparator ended on the start instant, so two runs in
 * one band with the same `startedAt` compared equal — and two whose starts were both
 * unreadable subtracted two floors into `NaN`. `Array.prototype.sort` hands an equal
 * pair back in the order it received them and is free to do anything at all with a
 * `NaN`, so both pairs held whatever order the enumeration supplied. A run list is
 * read again on every refresh, from a response that need not enumerate alike, so rows
 * swapped under a person between one read and the next.
 *
 * Each case runs the SAME rows through twice, supplied in opposite orders, and asserts
 * one output. Asserting a single expected order against one input would pass over a
 * comparator that had simply preserved that input.
 */
describe("the order two reads of one list agree on", () => {
  /** The same runs, enumerated forwards and backwards, as two reads would supply them. */
  function bothEnumerationsOf(
    runs: readonly WorkflowRunSnapshot[],
  ): readonly (readonly string[])[] {
    return [runs, [...runs].reverse()].map((enumeration) =>
      new RunListProjection(enumeration).rows.map((row) => row.run.workflowRunId),
    );
  }

  it("holds two runs started in the same millisecond in one order", () => {
    const [forwards, backwards] = bothEnumerationsOf([
      run({ workflowRunId: "run-b", startedAt: "2026-09-01T10:00:00.000Z" }),
      run({ workflowRunId: "run-a", startedAt: "2026-09-01T10:00:00.000Z" }),
    ]);
    expect(forwards).toStrictEqual(["run-a", "run-b"]);
    expect(backwards).toStrictEqual(forwards);
  });

  it("holds two runs whose starts are both unreadable in one order", () => {
    // The `NaN` half. Two floors subtract to `NaN`, which a comparator may not answer
    // at all — and which left this pair in enumeration order under a claim that it
    // did not.
    const [forwards, backwards] = bothEnumerationsOf([
      run({ workflowRunId: "run-b", startedAt: "2026-09-01T99:99:99.000Z" }),
      run({ workflowRunId: "run-a", startedAt: "2026-09-01T88:88:88.000Z" }),
    ]);
    expect(forwards).toStrictEqual(["run-a", "run-b"]);
    expect(backwards).toStrictEqual(forwards);
  });

  it("negative control: the run id never outranks the start", () => {
    // Without this, both cases above would pass over a list sorted by id alone —
    // which would put the oldest run at the top whenever its id happened to sort
    // first, and lose the newest-first reading the band ordering exists for.
    const [forwards, backwards] = bothEnumerationsOf([
      run({ workflowRunId: "run-a-older", startedAt: "2026-09-01T08:00:00.000Z" }),
      run({ workflowRunId: "run-z-newer", startedAt: "2026-09-01T12:00:00.000Z" }),
    ]);
    expect(forwards).toStrictEqual(["run-z-newer", "run-a-older"]);
    expect(backwards).toStrictEqual(forwards);
  });

  it("negative control: and never outranks the band", () => {
    // The same for the key above it: a settled run whose id sorts first still comes
    // after every parked one.
    const [forwards] = bothEnumerationsOf([
      run({
        workflowRunId: "run-a-settled",
        state: "completed",
        startedAt: "2026-09-01T12:00:00.000Z",
        phaseStates: [phase({ state: "completed" })],
      }),
      run({
        workflowRunId: "run-z-parked",
        startedAt: "2026-09-01T08:00:00.000Z",
        phaseStates: [
          phase({ state: "running", parkReason: "waiting-human", parkCause: "Sign-off." }),
        ],
      }),
    ]);
    expect(forwards).toStrictEqual(["run-z-parked", "run-a-settled"]);
  });
});
