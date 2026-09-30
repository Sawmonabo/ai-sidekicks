// The order the rows come out in, and the order two reads of one list agree on: which key wins,
// and that the keys settle every pair.

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

  it("puts the newest run first, and a parked run sits where its start puts it", () => {
    const projection = new RunListProjection([settled, activeOlder, activeNewer, parked]);
    expect(projection.rows.map((row) => row.run.workflowRunId)).toStrictEqual([
      "run-settled",
      "run-active-newer",
      "run-active-older",
      "run-parked",
    ]);
  });

  it("negative control: the input order is not the output order", () => {
    // Guards against a projection that returned an input that happened to arrive sorted.
    const input = [settled, activeOlder, activeNewer, parked];
    const projection = new RunListProjection(input);
    expect(projection.rows.map((row) => row.run.workflowRunId)).not.toStrictEqual(
      input.map((snapshot) => snapshot.workflowRunId),
    );
  });
});

/**
 * Two reads of one list, and the rows that must not move between them. Tied starts (equal, or
 * both unreadable) would otherwise follow enumeration order. Each case runs the same rows in
 * opposite orders and asserts one output, since one expected order could match a comparator that
 * preserved its input.
 */
describe("the order two reads of one list agree on", () => {
  /** The same runs enumerated forwards and backwards, as two reads would supply them. */
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
    // Two unreadable starts tie, so the run id alone settles the pair.
    const [forwards, backwards] = bothEnumerationsOf([
      run({ workflowRunId: "run-b", startedAt: "2026-09-01T99:99:99.000Z" }),
      run({ workflowRunId: "run-a", startedAt: "2026-09-01T88:88:88.000Z" }),
    ]);
    expect(forwards).toStrictEqual(["run-a", "run-b"]);
    expect(backwards).toStrictEqual(forwards);
  });

  it("negative control: the run id never outranks the start", () => {
    // Guards the cases above against a list sorted by id alone.
    const [forwards, backwards] = bothEnumerationsOf([
      run({ workflowRunId: "run-a-older", startedAt: "2026-09-01T08:00:00.000Z" }),
      run({ workflowRunId: "run-z-newer", startedAt: "2026-09-01T12:00:00.000Z" }),
    ]);
    expect(forwards).toStrictEqual(["run-z-newer", "run-a-older"]);
    expect(backwards).toStrictEqual(forwards);
  });
});
