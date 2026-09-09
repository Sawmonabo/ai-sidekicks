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
//
// AND A SEVENTH ACT THAT BELONGS TO NO RUN. The pane's empty state offers to put the
// caret in the composer, which is an operator action like any other and so is
// palette-reachable like any other — but it is not a control OF a run, so it is not a
// row in the set above and carries no run id. It is contributed here rather than from
// a seat of its own because a family owns ONE contribution: a second
// `useConsoleCommandSeat` under this owner would supersede these rows rather than
// join them. Its offer reading is `run-start-offer.ts`, the same function the empty
// state's own button is rendered on.

import { useMemo } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../../palette/index.js";
import { useLatestRef } from "../../../primitives/index.js";
import { type DriverCapabilityReadout } from "../../../bridge/index.js";
import { type RunProjection } from "../run-state-projection.js";
import {
  RUN_START_ACTION_LABEL,
  offersRunStart,
  type RunStartOfferReading,
} from "../run-start-offer.js";
import { RUN_CONTROL_PRESENTATION } from "./control-presentation.js";
import { useShellBlockFor, type FrameStore } from "../../../store/index.js";
import { RUN_CONTROL_METHODS, type RunControl } from "./run-control-dispatch.js";
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

/** The id the empty state's act is contributed under. Namespaced like the six. */
export const RUN_START_COMMAND_ID = "runs.writeMessage";

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
  /**
   * The window's own shell condition, which decides whether these rows may run.
   *
   * The same store the on-screen strip reads, so one outage closes one act once —
   * a palette row and a button that disagreed about whether a control is open would be
   * two answers to a question the frame's banner has already answered.
   */
  readonly frameStore: FrameStore;
  /** The pane's one dispatcher and its in-flight latch. */
  readonly surface: RunControlSurface;
  /** Open the steer form against this run, which is the row's own Steer button's act. */
  readonly onRequestSteer: (runId: string) => void;
  /** Open the rewind form against this run, which is the row's own Rewind button's act. */
  readonly onRequestRewind: (runId: string) => void;
  /**
   * What the empty state is reading, so the start row is offered exactly where its
   * button is. The predicate lives beside the button; this carries its inputs.
   */
  readonly startOffer: RunStartOfferReading;
  /** Ask the composer for the caret — the empty state's own button's act. */
  readonly onRequestComposerFocus: () => void;
}

/** Contribute the controls of every described run for as long as the pane is mounted. */
export function useRunControlCommands(input: RunControlCommandInput): void {
  const rows = runControlCommandRows(
    input.runs,
    input.driverCapabilities,
    goneRunIds(input.surface),
  );
  // Refreshed by every COMMITTED render and never in the render body: a registered
  // row reads the run list, the comparand source, and the pane's dispatcher through
  // this at invoke time, and a render-body write would let a concurrent pass React
  // throws away — one composed against another session's runs, another bridge's
  // surface — leave the row on screen dispatching through what that discarded pass
  // saw, latch and all.
  const inputRef = useLatestRef(input);

  // WHAT CLOSES THESE ROWS, subscribed off the one seam every dispatching surface asks,
  // and per METHOD because that is what the seam answers about. Three reads for the
  // three methods the six controls reach, exactly as the on-screen strip takes them.
  //
  // The row is LISTED and closed rather than withdrawn. A row that vanished during an
  // outage would answer "where did Pause go" with silence, and the `when` clause is
  // already this palette's affordance for an act that does not exist in the open
  // scope — which is a different fact from an act that exists and cannot be sent.
  const pauseBlock = useShellBlockFor(input.frameStore, RUN_CONTROL_METHODS.pause);
  const resumeBlock = useShellBlockFor(input.frameStore, RUN_CONTROL_METHODS.resume);
  const interveneBlock = useShellBlockFor(input.frameStore, RUN_CONTROL_METHODS.interrupt);
  const unavailableByMethod: Readonly<Record<string, string | undefined>> = {
    [RUN_CONTROL_METHODS.pause]: pauseBlock?.detail,
    [RUN_CONTROL_METHODS.resume]: resumeBlock?.detail,
    [RUN_CONTROL_METHODS.interrupt]: interveneBlock?.detail,
  };
  // The start row is composer focus and reaches no wire, so nothing closes it. Read
  // from the same three because the six that DO are what this constant is about.
  const closedSentence = pauseBlock?.detail ?? resumeBlock?.detail ?? interveneBlock?.detail;

  const offersStart = offersRunStart(input.startOffer);
  // The start act joins the signature as what it SAYS — offered or not — for the same
  // reason the rows do: the pane re-renders on every streamed event and only a change
  // in what the palette would list may re-register the owner.
  const signature = `${rows
    .map((row) => `${row.runId} ${row.control} ${row.title}`)
    .join("|")}#${String(offersStart)}#${closedSentence ?? ""}`;
  // Built from THIS render's rows rather than through a ref. The memo runs during the
  // render whose signature changed, which is before that render's layout effect has
  // refreshed anything, so a ref read here would build this render's commands out of
  // the previous pass's rows. The signature is the dependency because it is what the
  // rows SAY: keying on the array's identity would re-register six commands per run
  // on every streamed run event.
  const commands = useMemo(() => {
    const controlCommands = rows.map((row) =>
      buildRunControlCommand(row, inputRef, unavailableByMethod[RUN_CONTROL_METHODS[row.control]]),
    );
    return offersStart ? [...controlCommands, buildRunStartCommand(inputRef)] : controlCommands;
  }, [signature, inputRef]);

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
 * Ask the composer for the caret, while the pane's own control still asks for it.
 *
 * The re-read is not ceremony: a run arriving in the gap takes the empty state off
 * screen, and a palette that went on offering to start work in a pane full of runs
 * would be the second offer set this module exists to prevent.
 */
export function performRunStart(input: RunControlCommandInput): void {
  if (!offersRunStart(input.startOffer)) {
    return;
  }
  input.onRequestComposerFocus();
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
  /** The block's own sentence where one closes this control's method, else absent. */
  unavailable: string | undefined,
): ConsoleCommand {
  return {
    id: `runs.${row.control}.${row.runId}`,
    title: row.title,
    group: RUN_CONTROL_COMMAND_GROUP,
    when: RUN_CONTROL_COMMAND_WHEN,
    keywords: [row.runId, RUN_CONTROL_PRESENTATION[row.control].label],
    ...(unavailable === undefined ? {} : { unavailable }),
    run: () => {
      dispatchRunControlCommand(row, inputRef.current);
    },
  };
}

/**
 * The empty state's act, as a palette row.
 *
 * It carries the button's own label rather than a title of its own, so the two names
 * for one act cannot drift, and it reads the offer through the ref for the reason
 * every row here does: the pane can fill with runs between the row being contributed
 * and somebody pressing Enter.
 */
function buildRunStartCommand(inputRef: React.RefObject<RunControlCommandInput>): ConsoleCommand {
  return {
    id: RUN_START_COMMAND_ID,
    title: RUN_START_ACTION_LABEL,
    group: RUN_CONTROL_COMMAND_GROUP,
    when: RUN_CONTROL_COMMAND_WHEN,
    keywords: ["compose", "message", "start"],
    run: () => {
      performRunStart(inputRef.current);
    },
  };
}
