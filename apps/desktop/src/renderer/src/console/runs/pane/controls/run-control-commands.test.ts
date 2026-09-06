// What the palette is handed for the run controls, and what pressing one does.
//
// Asserted on the two pure halves rather than through a mounted pane: which rows
// exist is arithmetic over the offer reading, and what a row dispatches is a call
// into the surface the pane already owns. The pane's own suite covers the wiring.

import { describe, expect, it, vi } from "vitest";

import { type RunProjection } from "../run-state-projection.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import {
  carriedRunControlRefusal,
  type RunControl,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./run-control-dispatch.js";
import {
  dispatchRunControlCommand,
  runControlCommandRows,
  type RunControlCommandInput,
} from "./run-control-commands.js";
import { type RunControlSurface } from "./run-control-surface.js";

const FIRST_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const SECOND_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

/** A projection at rest, carrying the two members the contribution actually reads. */
function projection(runId: string, state: RunProjection["state"] = "running"): RunProjection {
  return {
    runId,
    runVersion: 7,
    state,
    trigger: undefined,
    intendedClose: false,
    failureCategory: undefined,
    providerFailureDetail: undefined,
    rewoundToPosition: undefined,
    executionPosture: undefined,
    firstSeenAtIso: "2026-09-02T09:00:00.000Z",
    updatedAtIso: "2026-09-02T09:00:00.000Z",
    statusRows: [],
  };
}

/** No run has been answered gone, which is every case but the two that say so. */
const NO_GONE_RUNS: ReadonlySet<string> = new Set<string>();

const CAPABLE = capabilityReadout(
  [["claude", ["steer", "rollback"]]],
  [
    [FIRST_RUN, "claude"],
    [SECOND_RUN, "claude"],
  ],
);

/** A surface whose dispatcher records the verb and target it was asked for. */
function recordingSurface(): {
  readonly surface: RunControlSurface;
  readonly calls: { verb: string; runId: string; expectedRunVersion: number }[];
} {
  const calls: { verb: string; runId: string; expectedRunVersion: number }[] = [];
  const record =
    (verb: RunControl) =>
    (target: { runId: string; expectedRunVersion: number }): Promise<RunControlOutcome> => {
      calls.push({ verb, runId: target.runId, expectedRunVersion: target.expectedRunVersion });
      // A settled outcome the stub does not have to fabricate: nothing under test
      // reads it, and building one through the real reader keeps the stub honest.
      return Promise.resolve(carriedRunControlRefusal(verb, new Error("stub")));
    };
  const dispatcher = {
    // The comparand is the dispatcher's own reconciliation; the stub answers with
    // the reading it was handed so an assertion can see WHICH version travelled.
    comparandFor: (_runId: string, streamReading: number) => streamReading,
    pause: record("pause"),
    resume: record("resume"),
    interrupt: record("interrupt"),
    cancel: record("cancel"),
  } as unknown as RunControlDispatcher;
  const surface: RunControlSurface = {
    dispatcher,
    records: [],
    inFlightKeys: new Set<string>(),
    dispatch: (_runId, _control, perform) => {
      void perform(dispatcher);
      return { admitted: true, dispatchToken: "token" };
    },
  };
  return { surface, calls };
}

function inputFor(
  runs: readonly RunProjection[],
  surface: RunControlSurface,
  overrides: Partial<RunControlCommandInput> = {},
): RunControlCommandInput {
  return {
    runs,
    driverCapabilities: CAPABLE,
    surface,
    onRequestSteer: () => undefined,
    onRequestRewind: () => undefined,
    ...overrides,
  };
}

describe("the rows the runs pane contributes", () => {
  it("contributes one row per control the row itself offers", () => {
    const rows = runControlCommandRows([projection(FIRST_RUN)], CAPABLE, NO_GONE_RUNS);

    expect(rows.map((row) => row.control)).toEqual([
      "pause",
      "interrupt",
      "steer",
      "cancel",
      "rollback",
    ]);
  });

  it("drops the gated pair where the bound driver declared neither", () => {
    const bare = capabilityReadout([["codex", []]], [[FIRST_RUN, "codex"]]);

    const rows = runControlCommandRows([projection(FIRST_RUN)], bare, NO_GONE_RUNS);

    expect(rows.map((row) => row.control)).toEqual(["pause", "interrupt", "cancel"]);
  });

  it("leaves the run unnamed while the session has only one", () => {
    const rows = runControlCommandRows([projection(FIRST_RUN)], CAPABLE, NO_GONE_RUNS);

    expect(rows[0]?.title).toBe("Pause the run");
  });

  it("names the run as soon as there are two to confuse", () => {
    const rows = runControlCommandRows(
      [projection(FIRST_RUN), projection(SECOND_RUN)],
      CAPABLE,
      NO_GONE_RUNS,
    );

    expect(rows[0]?.title).toBe(`Pause the run ${FIRST_RUN}`);
    expect(rows.filter((row) => row.runId === SECOND_RUN).length).toBeGreaterThan(0);
  });
});

describe("what running a contributed row does", () => {
  it("dispatches through the pane's own surface, carrying the run's comparand", () => {
    const { surface, calls } = recordingSurface();

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "interrupt", title: "Stop the run" },
      inputFor([projection(FIRST_RUN)], surface),
    );

    expect(calls).toEqual([{ verb: "interrupt", runId: FIRST_RUN, expectedRunVersion: 7 }]);
  });

  it("opens the composer for steer and rewind rather than sending an empty body", () => {
    const { surface, calls } = recordingSurface();
    const onRequestSteer = vi.fn();
    const onRequestRewind = vi.fn();
    const input = inputFor([projection(FIRST_RUN)], surface, {
      onRequestSteer,
      onRequestRewind,
    });

    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "steer", title: "Steer the run" },
      input,
    );
    dispatchRunControlCommand(
      { runId: FIRST_RUN, control: "rollback", title: "Rewind the run" },
      input,
    );

    expect(onRequestSteer).toHaveBeenCalledWith(FIRST_RUN);
    expect(onRequestRewind).toHaveBeenCalledWith(FIRST_RUN);
    expect(calls).toEqual([]);
  });

  it("sends nothing for a run the stream no longer describes", () => {
    const { surface, calls } = recordingSurface();

    dispatchRunControlCommand(
      { runId: SECOND_RUN, control: "cancel", title: "Cancel the run" },
      inputFor([projection(FIRST_RUN)], surface),
    );

    expect(calls).toEqual([]);
  });
});

describe("a run the daemon says is gone is contributed against by nobody", () => {
  it("drops every one of its rows while the runs beside it keep theirs", () => {
    // The row's own strip withdraws every control for a gone run, and the palette
    // offering them anyway would be the second offer set this module exists to stop.
    const rows = runControlCommandRows(
      [projection(FIRST_RUN), projection(SECOND_RUN)],
      CAPABLE,
      new Set([FIRST_RUN]),
    );

    expect(rows.every((row) => row.runId === SECOND_RUN)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("still names the run in the surviving titles, because two runs were described", () => {
    // The naming is decided over the DESCRIBED runs, not the contributed ones: a
    // gone row still sits on screen carrying its id, so a bare "Pause the run" in
    // the palette would be ambiguous against it.
    const rows = runControlCommandRows(
      [projection(FIRST_RUN), projection(SECOND_RUN)],
      CAPABLE,
      new Set([FIRST_RUN]),
    );

    expect(rows[0]?.title).toBe(`Pause the run ${SECOND_RUN}`);
  });
});
