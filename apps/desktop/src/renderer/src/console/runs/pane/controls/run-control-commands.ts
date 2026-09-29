// The run controls, contributed to the command palette.
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
// WHY THE COMMAND LIST IS PINNED TO A SIGNATURE. Contribution replaces an owner's rows
// and signals the palette to re-read, so a list rebuilt per render would re-register the
// commands per streamed run event and re-run the palette's search on every one. The rows
// are derived each render and the COMMANDS are rebuilt only when what those rows say
// changes. Everything that moves underneath them, the comparand most of all, is read at
// invoke time through a ref, so an advancing run version rewrites nothing.
//
// STEER OPENS THE COMPOSER, IT DOES NOT SEND. It needs a body the user has not written
// yet, and a palette entry that sent an empty steer would be inventing a message.

import { useMemo } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../../palette/index.js";
import { useLatestRef } from "../../../primitives/index.js";
import { type DriverCapabilityReadout } from "@renderer/console/bridge/driver-capabilities/driver-capability-read.js";
import type { RunState } from "@ai-sidekicks/contracts";
import { RUN_CONTROL_PRESENTATION } from "@renderer/features/composer/run-controls/run-control-presentation.js";
import { type RunControl } from "@renderer/features/composer/run-controls/services/run-control-dispatch.js";
import { offeredRunControls } from "@renderer/features/composer/run-controls/run-control-gating.js";
import { type RunControlSurface } from "./run-control-surface.js";

/** The owner these rows are contributed under. One per family, one live at a time. */
export const RUN_CONTROL_COMMAND_OWNER = "runs-family";

/** The palette category the controls sit under. */
const RUN_CONTROL_COMMAND_GROUP = "Run";

/**
 * The clause these commands are offered under.
 *
 * `sessionActive` and nothing narrower: a run control belongs to a session, and
 * the finer question — which run, and which control it offers — is answered by
 * whether the command was contributed at all, not by a clause the palette
 * evaluates. Encoding "there is a live run" as a clause key would put a fact that
 * changes with every event into a vocabulary the frame recomputes once per route.
 */
const RUN_CONTROL_COMMAND_WHEN = "sessionActive";

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
 * Contribute the controls of every described run for as long as the caller is mounted.
 */
export function useRunControlCommands(input: RunControlCommandInput): void {
  const rows = runControlCommandRows(input.runs, input.driverCapabilities);
  // Refreshed by every COMMITTED render and never in the render body: a registered
  // row reads the run list, the comparand source, and the dispatcher through
  // this at invoke time, and a render-body write would let a concurrent pass React
  // throws away — one composed against another session's runs, another bridge's
  // surface — leave the row on screen dispatching through what that discarded pass
  // saw, latch and all.
  const inputRef = useLatestRef(input);

  // The commands are keyed by what the rows SAY: the caller re-renders on every
  // streamed event and only a change in what the palette would list may re-register
  // the owner.
  const signature = rows.map((row) => `${row.runId} ${row.control} ${row.title}`).join("|");
  // Built from THIS render's rows rather than through a ref. The memo runs during the
  // render whose signature changed, which is before that render's layout effect has
  // refreshed anything, so a ref read here would build this render's commands out of
  // the previous pass's rows. The signature is the dependency because it is what the
  // rows SAY: keying on the array's identity would re-register commands per run
  // on every streamed run event.
  const commands = useMemo(
    () => rows.map((row) => buildRunControlCommand(row, inputRef)),
    [signature, inputRef],
  );

  useConsoleCommandSeat(RUN_CONTROL_COMMAND_OWNER, commands);
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

/**
 * One command, closed over nothing that moves.
 *
 * The ref is read inside `run` rather than at build time, so a command built when
 * a run was at version 4 dispatches against whatever version the stream has
 * reached by the time somebody presses Enter, which is exactly what the row's own
 * button does and the reason a stale comparand cannot be baked into a palette
 * entry that outlives it.
 */
function buildRunControlCommand(
  row: RunControlCommandRow,
  inputRef: React.RefObject<RunControlCommandInput>,
): ConsoleCommand {
  return {
    id: `runs.${row.control}.${row.runId}`,
    title: row.title,
    group: RUN_CONTROL_COMMAND_GROUP,
    when: RUN_CONTROL_COMMAND_WHEN,
    keywords: [row.runId, RUN_CONTROL_PRESENTATION[row.control].label],
    run: () => {
      dispatchRunControlCommand(row, inputRef.current);
    },
  };
}
