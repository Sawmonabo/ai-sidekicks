// The run controls as palette rows: which rows each run offers, and what pressing one does.
//
// A palette row dispatches the same call as the on-screen control, through the one dispatcher,
// so both share one idempotency key and one in-flight latch; a second dispatcher would mint a
// second key against one run version, which the wire reads as two mutations. Each live run
// contributes its own rows, and the run id joins the title only when there is more than one.
// Steer opens the composer rather than sending, because it needs a body not yet written.

import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { RUN_CONTROL_PRESENTATION } from "../run-control-presentation.js";
import { offeredRunControls } from "../run-control-gating.js";
import { type RunControl } from "../services/run-control-dispatch.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

/** The owner these rows are contributed under. One live at a time. */
export const RUN_CONTROL_COMMAND_OWNER = "run-controls";

/** What a contributed row says. Derived per render; cheap and allocation-light. */
export interface RunControlCommandRow {
  readonly runId: string;
  readonly control: RunControl;
  readonly title: string;
}

/** One run as the commands need it: its identity, its guard, and its state. */
export interface RunControlCommandRun {
  readonly runId: string;
  /** The comparand every guarded mutation threads back. Wire-supplied, never guessed. */
  readonly runVersion: number;
  readonly state: RunState;
}

/** What the commands act on, read at invoke time rather than captured. */
export interface RunControlCommandInput {
  /** The runs the live stream has described. A row is contributed per offered control. */
  readonly runs: readonly RunControlCommandRun[];
  readonly driverCapabilities: DriverCapabilityReadout | undefined;
  /** The one dispatcher and its in-flight latch. */
  readonly dispatchState: RunControlDispatchState;
  /** Open the steer form against this run. */
  readonly onRequestSteer: (runId: string) => void;
}

/** One row per control each run offers, in the row's own order. */
export function runControlCommandRows(
  runs: readonly RunControlCommandRun[],
  driverCapabilities: DriverCapabilityReadout | undefined,
): readonly RunControlCommandRow[] {
  const rows: RunControlCommandRow[] = [];
  const namesTheRun = runs.length > 1;
  for (const run of runs) {
    const offered = offeredRunControls(run, driverCapabilities);
    for (const control of [...offered.primary, ...offered.overflow]) {
      const presentation = RUN_CONTROL_PRESENTATION[control];
      rows.push({
        runId: run.runId,
        control,
        title: namesTheRun ? `${presentation.title} ${run.runId}` : presentation.title,
      });
    }
  }
  return rows;
}

/**
 * Perform one contributed control. A run absent from the stream is not dispatched
 * against: its comparand would be a remembered version the console cannot vouch for, so a
 * press in the gap before the row leaves the palette does nothing.
 */
export function dispatchRunControlCommand(
  row: RunControlCommandRow,
  input: RunControlCommandInput,
): void {
  const run = input.runs.find((candidate) => candidate.runId === row.runId);
  if (run === undefined) {
    return;
  }
  // Bound to a `const` because a property access re-widens to the whole union across a
  // function boundary, which would break the exhaustive tail.
  const control = row.control;
  if (control === "steer") {
    input.onRequestSteer(row.runId);
    return;
  }
  const { dispatchState } = input;
  const target = {
    runId: run.runId,
    expectedRunVersion: dispatchState.dispatcher.comparandFor(run.runId, run.runVersion),
  };
  dispatchState.dispatch(run.runId, control, (dispatcher) => {
    switch (control) {
      case "pause":
        return dispatcher.pause(target);
      case "resume":
        return dispatcher.resume(target);
      case "interrupt":
        return dispatcher.interrupt(target);
      default: {
        // `steer` returned above; the exhaustive tail makes that a proof, not a convention.
        const unreachable: never = control;
        throw new Error(`unhandled run control ${String(unreachable)}`);
      }
    }
  });
}
