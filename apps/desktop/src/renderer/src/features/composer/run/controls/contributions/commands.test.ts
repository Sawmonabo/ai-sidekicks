// What the contributed run-control rows are and what pressing one does: a control dispatches
// through the caller's dispatch state, guarded with the run's comparand, and a steer row, one per
// child, opens that child's box.

import { describe, expect, it } from "vitest";

import {
  RUN_ID as FIRST_RUN,
  commandRun,
  recordingRunControlDispatch,
} from "../commands.test-support.js";
import {
  dispatchRunControlCommand,
  runControlCommandRows,
  type RunChild,
  type RunControlCommandInput,
  type RunControlCommandRun,
} from "./commands.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

function inputFor(
  runs: readonly RunControlCommandRun[],
  dispatchState: RunControlDispatchState,
): RunControlCommandInput {
  return {
    runs,
    dispatchState,
    onRequestSteer: () => undefined,
  };
}

const BUILDER: RunChild = { childHandle: "agent-builder-1", agentName: "builder" };

describe("what running a contributed row does", () => {
  it("dispatches through the caller's dispatch state, carrying the run's comparand", () => {
    const { dispatchState, calls } = recordingRunControlDispatch();

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "interrupt", title: "Stop the run" },
      inputFor([commandRun(FIRST_RUN)], dispatchState),
    );

    expect(calls).toEqual([{ verb: "interrupt", runId: FIRST_RUN, expectedRunVersion: 7 }]);
  });

  it("offers a steer row per child, which opens that child's box", () => {
    const { dispatchState, calls } = recordingRunControlDispatch();
    const parent = commandRun(FIRST_RUN, "running", [BUILDER]);
    const steerRow = runControlCommandRows([parent]).find((row) => row.control === "steer");
    if (steerRow === undefined) {
      throw new Error("a run with a child offered no steer row");
    }
    expect(steerRow.title).toBe("Steer builder");
    const steered: [string, RunChild][] = [];
    dispatchRunControlCommand(steerRow, {
      ...inputFor([parent], dispatchState),
      onRequestSteer: (runId, child) => {
        steered.push([runId, child]);
      },
    });

    expect(steered).toEqual([[FIRST_RUN, BUILDER]]);
    expect(calls).toEqual([]);
  });
});
