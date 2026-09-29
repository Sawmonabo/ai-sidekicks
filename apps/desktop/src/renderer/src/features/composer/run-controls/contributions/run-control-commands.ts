// The run controls as palette rows: which rows each run offers, and what pressing one does.
//
// Every operator action is palette-reachable. What the palette lists dispatches the
// SAME call any other surface does — one dispatcher, one idempotency key, one in-flight
// latch — so a control pressed from the palette settles into the same record. A second
// dispatcher here would mint a second key against one run version, which the wire reads
// as two distinct mutations rather than replays of one.
//
// WHICH CONTROLS, AND ON WHICH RUN. `offeredRunControls` answers the first: a driver
// that declared no `steer` takes it out of the palette by that one call. The second is
// answered per run rather than by picking one: a palette listing "Pause the run" with
// three live runs in the session is a palette that invites a mistake, which is the very
// reason the palette carries a scoped-context row. So each live run contributes its own
// set, and the run id joins the title exactly when the session has more than one run to
// confuse it with.
//
// STEER OPENS THE COMPOSER, IT DOES NOT SEND. It needs a body the user has not written
// yet, and a palette entry that sent an empty steer would be inventing a message.

import type { RunState } from "@ai-sidekicks/contracts";

import { type DriverCapabilityReadout } from "@renderer/console/bridge/driver-capabilities/driver-capability-read.js";
import { RUN_CONTROL_PRESENTATION } from "../run-control-presentation.js";
import { offeredRunControls } from "../run-control-gating.js";
import { type RunControl } from "../services/run-control-dispatch.js";
import { type RunControlSurface } from "../hooks/useRunControlDispatch.js";

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
  readonly surface: RunControlSurface;
  /** Open the steer form against this run. */
  readonly onRequestSteer: (runId: string) => void;
}

/**
 * One row per control each run offers, in the row's own order.
 *
 * The run id joins the title only where the session has more than one run to
 * confuse it with. With one run "Pause the run" is unambiguous and the id is
 * noise; with two it is the only thing distinguishing the entries.
 */
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
 * Perform one contributed control.
 *
 * A run the stream no longer describes is not dispatched against: its comparand
 * would be the dispatcher's last remembered version for a run that has since gone,
 * and sending a guard the console cannot vouch for is exactly what the mandatory
 * comparand exists to prevent. The row leaves the palette on the next
 * contribution; a press that lands in the gap does nothing rather than something
 * unguarded.
 */
export function dispatchRunControlCommand(
  row: RunControlCommandRow,
  input: RunControlCommandInput,
): void {
  const run = input.runs.find((candidate) => candidate.runId === row.runId);
  if (run === undefined) {
    return;
  }
  // Bound to a `const` rather than read off the row inside the closure below: a
  // property access re-widens to the whole union once it crosses a function
  // boundary, so the two early returns would stop being a proof and the exhaustive
  // tail would stop compiling.
  const control = row.control;
  if (control === "steer") {
    input.onRequestSteer(row.runId);
    return;
  }
  const { surface } = input;
  const target = {
    runId: run.runId,
    expectedRunVersion: surface.dispatcher.comparandFor(run.runId, run.runVersion),
  };
  surface.dispatch(run.runId, control, (dispatcher) => {
    switch (control) {
      case "pause":
        return dispatcher.pause(target);
      case "resume":
        return dispatcher.resume(target);
      case "interrupt":
        return dispatcher.interrupt(target);
      default: {
        // `steer` returned above; the exhaustive tail is what makes that early
        // return a proof rather than a convention.
        const unreachable: never = control;
        throw new Error(`unhandled run control ${String(unreachable)}`);
      }
    }
  });
}
