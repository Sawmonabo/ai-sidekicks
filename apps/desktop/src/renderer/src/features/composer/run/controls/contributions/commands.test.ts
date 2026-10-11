// What pressing a contributed run-control row does: it dispatches through the caller's dispatch
// state, guarded with the run's comparand.

import { describe, expect, it } from "vitest";

import {
  RUN_ID as FIRST_RUN,
  commandRun,
  recordingRunControlDispatch,
} from "../commands.test-support.js";
import {
  dispatchRunControlCommand,
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

describe("what running a contributed row does", () => {
  it("dispatches through the caller's dispatch state, carrying the run's comparand", () => {
    const { dispatchState, calls } = recordingRunControlDispatch();

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "interrupt", title: "Stop the run" },
      inputFor([commandRun(FIRST_RUN)], dispatchState),
    );

    expect(calls).toEqual([{ verb: "interrupt", runId: FIRST_RUN, expectedRunVersion: 7 }]);
  });
});
