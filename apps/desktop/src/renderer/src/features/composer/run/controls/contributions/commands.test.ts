// What the contributed run-control rows are and what pressing one does: the run in view offers
// its controls by their own words, with no id, and a control dispatches through the caller's
// dispatch state, guarded with the run's comparand.

import { describe, expect, it } from "vitest";

import {
  RUN_ID as FIRST_RUN,
  commandRun,
  recordingRunControlDispatch,
} from "../commands.test-support.js";
import { dispatchRunControlCommand, runControlCommandRows } from "./commands.js";

describe("what running a contributed row does", () => {
  it("dispatches through the caller's dispatch state, carrying the run's comparand", async () => {
    const { dispatchState, calls } = recordingRunControlDispatch();
    const run = commandRun(FIRST_RUN);
    const rows = runControlCommandRows(run);
    // The rows read the controls' own words; the run's id is in none of them.
    expect(rows.map((row) => row.title)).toStrictEqual(["Pause the run", "Stop the run"]);
    const interrupt = rows.find((row) => row.control === "interrupt");
    if (interrupt === undefined) {
      throw new Error("a running run offered no interrupt row");
    }

    await dispatchRunControlCommand(interrupt, { run, dispatchState });

    expect(calls).toEqual([{ verb: "interrupt", runId: FIRST_RUN, expectedRunVersion: 7 }]);
  });
});
