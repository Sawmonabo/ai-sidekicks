// The run controls as palette rows: which rows each run offers, and what pressing one does.
//
// A palette row dispatches the same call as the on-screen control, through the one dispatcher,
// so both share one idempotency key and one in-flight latch; a second dispatcher would mint a
// second key against one run version, which the wire reads as two mutations. Each live run
// contributes its own rows, and the run id joins the title only when there is more than one.
// Steer opens a child's steer box rather than sending, because it needs a body not yet written,
// so it is offered once per child, named for the child's agent.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { RUN_CONTROL_PRESENTATION } from "../presentation.js";
import { offeredRunControls } from "../gating.js";
import { type RunControl } from "../services/dispatch.js";
import { type RunControlDispatchState } from "../hooks/useRunControlDispatch.js";

/** The owner these rows are contributed under. One live at a time. */
export const RUN_CONTROL_COMMAND_OWNER = "run-controls";

/**
 * What a contributed row says. Derived per render; cheap and allocation-light. A steer row names
 * the child whose box it opens.
 */
export type RunControlCommandRow =
  | {
      readonly runId: string;
      readonly control: Exclude<RunControl, "steer">;
      readonly title: string;
    }
  | {
      readonly runId: string;
      readonly control: "steer";
      readonly title: string;
      readonly child: RunChild;
    };

/** A child of a run, as a steer needs it: the daemon's handle for it and its agent's name. */
export interface RunChild {
  readonly childHandle: string;
  readonly agentName: string;
}

/** One run as the commands need it: its identity, its guard, its state and its children. */
export interface RunControlCommandRun {
  readonly runId: string;
  /** The comparand every guarded mutation threads back. Wire-supplied, never guessed. */
  readonly runVersion: number;
  readonly state: RunState;
  /** The children a steer can go to; a run with none offers no steer. */
  readonly children: readonly RunChild[];
}

/** What the commands act on, read at invoke time rather than captured. */
export interface RunControlCommandInput {
  /** The runs the live stream has described. A row is contributed per offered control. */
  readonly runs: readonly RunControlCommandRun[];
  /** The one dispatcher and its in-flight latch. */
  readonly dispatchState: RunControlDispatchState;
  /** Open the steer box for this child of this run. */
  readonly onRequestSteer: (runId: string, child: RunChild) => void;
}

/** One row per control each run offers, in the row's own order, and one steer row per child. */
export function runControlCommandRows(
  runs: readonly RunControlCommandRun[],
): readonly RunControlCommandRow[] {
  const rows: RunControlCommandRow[] = [];
  const namesTheRun = runs.length > 1;
  for (const run of runs) {
    const offered = offeredRunControls(run.state, run.children.length > 0);
    const titled = (title: string): string => (namesTheRun ? `${title} ${run.runId}` : title);
    for (const control of offered.primary) {
      rows.push({
        runId: run.runId,
        control,
        title: titled(RUN_CONTROL_PRESENTATION[control].title),
      });
    }
    for (const control of offered.overflow) {
      for (const child of run.children) {
        rows.push({
          runId: run.runId,
          control,
          title: titled(`${RUN_CONTROL_PRESENTATION[control].label} ${child.agentName}`),
          child,
        });
      }
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
  if (row.control === "steer") {
    input.onRequestSteer(row.runId, row.child);
    return;
  }
  // Bound to a `const` because a property access re-widens to the whole union across a
  // function boundary, which would break the exhaustive tail.
  const control = row.control;
  const { dispatchState } = input;
  const target = {
    runId: run.runId,
    expectedRunVersion: dispatchState.dispatcher.comparandFor(run.runId, run.runVersion),
  };
  dispatchState.dispatch({ runId: run.runId }, control, (dispatcher) => {
    switch (control) {
      case "pause":
        return dispatcher.pause(target);
      case "resume":
        return dispatcher.resume(target);
      case "interrupt":
        return dispatcher.interrupt(target);
      default: {
        // The steer row returned above; the exhaustive tail makes that a proof, not a convention.
        const unreachable: never = control;
        throw new Error(`unhandled run control ${String(unreachable)}`);
      }
    }
  });
}
