// The run controls as palette rows: which rows the run the palette was opened over offers, and
// what pressing one does.
//
// A palette row dispatches the same call as the on-screen control, through the one dispatcher,
// so both share one idempotency key and one in-flight latch; a second dispatcher would mint a
// second key against one run version, which the wire reads as two mutations. The rows act on the
// one run in view, so a row names neither the run nor its agent; a child's controls are reached
// in its own view.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { RUN_CONTROL_PRESENTATION } from "../presentation.js";
import { offeredRunControls, type PaletteRunControl } from "../gating.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

/** The owner these rows are contributed under. One live at a time. */
export const RUN_CONTROL_COMMAND_OWNER = "run-controls";

/** What a contributed row says: the control's own words, for the run it was offered by. */
export interface RunControlCommandRow {
  readonly runId: string;
  readonly control: PaletteRunControl;
  readonly title: string;
}

/** One run as the controls need it: its identity, its guard and its state. */
export interface RunControlCommandRun {
  /** The session the run is in, which a child's steer names. */
  readonly sessionId: string;
  readonly runId: string;
  /** The comparand every guarded mutation threads back. Wire-supplied, never guessed. */
  readonly runVersion: number;
  readonly state: RunState;
}

/** What the commands act on, read at invoke time rather than captured. */
export interface RunControlCommandInput {
  /** The run the palette acts on, once the live stream has described it. */
  readonly run: RunControlCommandRun | undefined;
  /** The one dispatcher and its in-flight latch. */
  readonly dispatchState: RunControlDispatchState;
}

/** One row per control the run offers, in the row's own order; none with no run. */
export function runControlCommandRows(
  run: RunControlCommandRun | undefined,
): readonly RunControlCommandRow[] {
  if (run === undefined) {
    return [];
  }
  return offeredRunControls(run.state).map((control) => ({
    runId: run.runId,
    control,
    title: RUN_CONTROL_PRESENTATION[control].title,
  }));
}

/**
 * Perform one contributed control, settling when its dispatch has, rejecting with the daemon's
 * refusal. A row whose run is no longer the one in view is not dispatched against: its comparand
 * would be a remembered version the console cannot vouch for, so a press in the gap before the
 * row leaves the palette does nothing.
 */
export async function dispatchRunControlCommand(
  row: RunControlCommandRow,
  input: RunControlCommandInput,
): Promise<void> {
  const { run, dispatchState } = input;
  if (run === undefined || run.runId !== row.runId) {
    return;
  }
  // Bound to a `const` because a property access re-widens to the whole union across a
  // function boundary, which would break the exhaustive tail.
  const control = row.control;
  const target = {
    runId: run.runId,
    expectedRunVersion: dispatchState.dispatcher.comparandFor(run.runId, run.runVersion),
  };
  const admission = dispatchState.dispatch({ runId: run.runId }, control, (dispatcher) => {
    switch (control) {
      case "pause":
        return dispatcher.pause(target);
      case "resume":
        return dispatcher.resume(target);
      case "interrupt":
        return dispatcher.interrupt(target);
      default: {
        const unreachable: never = control;
        throw new Error(`unhandled run control ${String(unreachable)}`);
      }
    }
  });
  if (admission.admitted) {
    await admission.settled;
  }
}
