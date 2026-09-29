// The run controls, contributed to the command palette for as long as the caller is mounted.
//
// Which rows exist and what each dispatches are `contributions/run-control-commands.ts`'s.
//
// WHY THE COMMAND LIST IS PINNED TO A SIGNATURE. Contribution replaces an owner's rows
// and signals the palette to re-read, so a list rebuilt per render would re-register the
// commands per streamed run event and re-run the palette's search on every one. The rows
// are derived each render and the COMMANDS are rebuilt only when what those rows say
// changes. Everything that moves underneath them, the comparand most of all, is read at
// invoke time through a ref, so an advancing run version rewrites nothing.

import { useMemo } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "@renderer/console/palette/index.js";
import { useLatestRef } from "@renderer/console/primitives/index.js";
import { RUN_CONTROL_PRESENTATION } from "../run-control-presentation.js";
import {
  RUN_CONTROL_COMMAND_OWNER,
  dispatchRunControlCommand,
  runControlCommandRows,
  type RunControlCommandInput,
  type RunControlCommandRow,
} from "../contributions/run-control-commands.js";

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
