// The six run controls, contributed to the command palette.
//
// `Spec-023 §Console Design (Meridian)` requires every operator action to be
// palette-reachable, and the runs surface is where six of them live. What the
// palette lists dispatches the SAME call the row's button does — one dispatcher,
// one idempotency key, one in-flight latch — so a control pressed from the palette
// goes busy on the row and settles into the same record. A second dispatcher here
// would mint a second key against one run version, which the wire reads as two
// distinct mutations rather than replays of one.
//
// WHICH CONTROLS, AND ON WHICH RUN. `offeredRunControls` answers the first, and it
// is the row's own reading rather than a copy of its rules — a driver that
// declared no `rollback` takes Rewind off the row and out of the palette by one
// call, not by two files agreeing. The second is answered per run rather than by
// picking one: a palette listing "Pause the run" with three live runs in the
// session is a palette that invites a mistake, which is the very reason the
// palette carries a scoped-context row. So each live run contributes its own set,
// and the run id joins the title exactly when the session has more than one run to
// confuse it with.
//
// WHY THE COMMAND LIST IS PINNED TO A SIGNATURE. Contribution replaces an owner's
// rows and signals the palette to re-read, so a list rebuilt per render would
// re-register six commands per streamed run event and re-run the palette's search
// on every one. The rows are derived each render — six comparisons per run, no
// allocation beyond the strings — and the COMMANDS are rebuilt only when what
// those rows say changes. Everything that moves underneath them, the comparand
// most of all, is read at invoke time through a ref, so an advancing run version
// rewrites nothing.
//
// STEER AND REWIND OPEN THE COMPOSER, THEY DO NOT SEND. Both need a body the
// participant has not written yet, and the row's own buttons open the same form.
// A palette entry that sent an empty steer would be inventing a message.

import { useMemo, useRef } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../../palette/index.js";
import { type DriverCapabilityReadout } from "../../../bridge/index.js";
import { type RunProjection } from "../run-state-projection.js";
import { RUN_CONTROL_PRESENTATION } from "./control-presentation.js";
import { type RunControl } from "./run-control-dispatch.js";
import { offeredRunControls } from "./run-control-gating.js";
import { goneRunIds } from "./run-control-reading.js";
import { type RunControlSurface } from "./run-control-surface.js";

/** The owner these rows are contributed under. One per family, one live at a time. */
export const RUN_CONTROL_COMMAND_OWNER = "runs-family";

/** The palette category the six sit under. */
const RUN_CONTROL_COMMAND_GROUP = "Run";

/**
 * The clause these commands are offered under.
 *
 * `sessionActive` and nothing narrower: a run control belongs to a session, and
 * the finer question — which run, and which of the six it offers — is answered by
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

/** What the commands act on, read at invoke time rather than captured. */
export interface RunControlCommandInput {
  /** The runs the live stream has described. A row is contributed per offered control. */
  readonly runs: readonly RunProjection[];
  readonly driverCapabilities: DriverCapabilityReadout | undefined;
  /** The pane's one dispatcher and its in-flight latch. */
  readonly surface: RunControlSurface;
  /** Open the steer form against this run, which is the row's own Steer button's act. */
  readonly onRequestSteer: (runId: string) => void;
  /** Open the rewind form against this run, which is the row's own Rewind button's act. */
  readonly onRequestRewind: (runId: string) => void;
}

/** Contribute the controls of every described run for as long as the pane is mounted. */
export function useRunControlCommands(input: RunControlCommandInput): void {
  const rows = runControlCommandRows(
    input.runs,
    input.driverCapabilities,
    goneRunIds(input.surface),
  );
  // Assigned during render, before the memo below reads it, so the rebuild that a
  // changed signature triggers sees this render's rows rather than the previous
  // pass's. The same shape `frame/frame-commands.ts` uses for its when-context.
  const rowsRef = useRef<readonly RunControlCommandRow[]>(rows);
  rowsRef.current = rows;
  const inputRef = useRef<RunControlCommandInput>(input);
  inputRef.current = input;

  const signature = rows.map((row) => `${row.runId} ${row.control} ${row.title}`).join("|");
  const commands = useMemo(
    () => rowsRef.current.map((row) => buildRunControlCommand(row, inputRef)),
    [signature],
  );

  useConsoleCommandSeat(RUN_CONTROL_COMMAND_OWNER, commands);
}

/**
 * One row per control each run offers, in the row's own order.
 *
 * The run id joins the title only where the session has more than one run to
 * confuse it with. With one run "Pause the run" is unambiguous and the id is
 * noise; with two it is the only thing distinguishing the entries — and the
 * NAMING is decided over the described runs rather than the contributed ones, so a
 * gone run still disambiguates the titles of the runs beside it.
 */
export function runControlCommandRows(
  runs: readonly RunProjection[],
  driverCapabilities: DriverCapabilityReadout | undefined,
  /**
   * Runs the daemon has answered do not exist. Contributed against by nobody: the
   * row's strip withdraws every control for one of these, and a palette that kept
   * offering them would be the second set this whole module exists to prevent.
   */
  goneRuns: ReadonlySet<string>,
): readonly RunControlCommandRow[] {
  const rows: RunControlCommandRow[] = [];
  const namesTheRun = runs.length > 1;
  for (const run of runs) {
    if (goneRuns.has(run.runId)) {
      continue;
    }
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
  if (control === "rollback") {
    input.onRequestRewind(row.runId);
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
      case "cancel":
        return dispatcher.cancel(target);
      default: {
        // `steer` and `rollback` returned above; the exhaustive tail is what makes
        // that pair of early returns a proof rather than a convention.
        const unreachable: never = control;
        throw new Error(`unhandled run control ${String(unreachable)}`);
      }
    }
  });
}
