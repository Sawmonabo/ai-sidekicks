// What the palette is handed for the run controls, and what pressing one does.
//
// Asserted on the two pure halves rather than through a mounted pane: which rows
// exist is arithmetic over the offer reading, and what a row dispatches is a call
// into the surface the pane already owns. The pane's own suite covers the wiring.

import { describe, expect, it, vi } from "vitest";

import { capabilityReadout } from "../driver-capability-readout.test-support.js";
import {
  RUN_ID as FIRST_RUN,
  SECOND_RUN_ID as SECOND_RUN,
  commandRun,
  recordingRunControlDispatch,
} from "../run-control-commands.test-support.js";
import {
  dispatchRunControlCommand,
  runControlCommandRows,
  type RunControlCommandInput,
  type RunControlCommandRun,
} from "./run-control-commands.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

const CAPABLE = capabilityReadout(
  [["claude", ["steer"]]],
  [
    [FIRST_RUN, "claude"],
    [SECOND_RUN, "claude"],
  ],
);

function inputFor(
  runs: readonly RunControlCommandRun[],
  surface: RunControlDispatchState,
  overrides: Partial<RunControlCommandInput> = {},
): RunControlCommandInput {
  return {
    runs,
    driverCapabilities: CAPABLE,
    surface,
    onRequestSteer: () => undefined,
    ...overrides,
  };
}

describe("the rows the runs pane contributes", () => {
  it("contributes one row per control the row itself offers", () => {
    const rows = runControlCommandRows([commandRun(FIRST_RUN)], CAPABLE);

    expect(rows.map((row) => row.control)).toEqual(["pause", "interrupt", "steer"]);
  });

  it("drops steer where the bound driver did not declare it", () => {
    const bare = capabilityReadout([["codex", []]], [[FIRST_RUN, "codex"]]);

    const rows = runControlCommandRows([commandRun(FIRST_RUN)], bare);

    expect(rows.map((row) => row.control)).toEqual(["pause", "interrupt"]);
  });

  it("leaves the run unnamed while the session has only one", () => {
    const rows = runControlCommandRows([commandRun(FIRST_RUN)], CAPABLE);

    expect(rows[0]?.title).toBe("Pause the run");
  });

  it("names the run as soon as there are two to confuse", () => {
    const rows = runControlCommandRows([commandRun(FIRST_RUN), commandRun(SECOND_RUN)], CAPABLE);

    expect(rows[0]?.title).toBe(`Pause the run ${FIRST_RUN}`);
    expect(rows.filter((row) => row.runId === SECOND_RUN).length).toBeGreaterThan(0);
  });
});

describe("what running a contributed row does", () => {
  it("dispatches through the pane's own surface, carrying the run's comparand", () => {
    const { surface, calls } = recordingRunControlDispatch();

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "interrupt", title: "Stop the run" },
      inputFor([commandRun(FIRST_RUN)], surface),
    );

    expect(calls).toEqual([{ verb: "interrupt", runId: FIRST_RUN, expectedRunVersion: 7 }]);
  });

  it("opens the composer for steer rather than sending an empty body", () => {
    const { surface, calls } = recordingRunControlDispatch();
    const onRequestSteer = vi.fn();
    const input = inputFor([commandRun(FIRST_RUN)], surface, { onRequestSteer });

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "steer", title: "Steer the run" },
      input,
    );

    expect(onRequestSteer).toHaveBeenCalledWith(FIRST_RUN);
    expect(calls).toEqual([]);
  });

  it("sends nothing for a run the stream no longer describes", () => {
    const { surface, calls } = recordingRunControlDispatch();

    dispatchRunControlCommand(
      { runId: SECOND_RUN, control: "interrupt", title: "Stop the run" },
      inputFor([commandRun(FIRST_RUN)], surface),
    );

    expect(calls).toEqual([]);
  });
});
