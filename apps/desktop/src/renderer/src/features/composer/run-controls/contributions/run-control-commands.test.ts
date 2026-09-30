// What pressing a contributed run-control row does: it dispatches through the caller's dispatch
// state, guarded with the run's comparand.

import { describe, expect, it } from "vitest";

import { capabilityReadout } from "../driver-capability-readout.test-support.js";
import {
  RUN_ID as FIRST_RUN,
  commandRun,
  recordingRunControlDispatch,
} from "../run-control-commands.test-support.js";
import {
  dispatchRunControlCommand,
  type RunControlCommandInput,
  type RunControlCommandRun,
} from "./run-control-commands.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

const CAPABLE = capabilityReadout([["claude", ["steer"]]], [[FIRST_RUN, "claude"]]);

function inputFor(
  runs: readonly RunControlCommandRun[],
  dispatchState: RunControlDispatchState,
): RunControlCommandInput {
  return {
    runs,
    driverCapabilities: CAPABLE,
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
