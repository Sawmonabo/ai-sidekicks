// The run controls, contributed to the command palette for as long as the caller is mounted.
//
// Contribution replaces an owner's rows and re-runs the palette's search, so the commands are
// rebuilt only when what the rows say changes. Everything that moves underneath them, the
// comparand most of all, is read at invoke time through a ref.

import { useMemo } from "react";

import { useRegisterCommands } from "@renderer/registries/commands/hooks/useRegisterCommands.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
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
 * The clause these commands are offered under: `sessionActive` and nothing narrower, since a
 * fact that changes with every event does not belong in a vocabulary recomputed per route.
 */
const RUN_CONTROL_COMMAND_WHEN = "sessionActive";

/** Contributes the controls of every described run while the caller is mounted. */
export function useRunControlCommands(input: RunControlCommandInput): void {
  const rows = runControlCommandRows(input.runs, input.driverCapabilities);
  // Refreshed by every committed render, never in the render body: a write during a render
  // React discards would leave a row on screen dispatching through that pass's runs and latch.
  const inputRef = useLatestRef(input);

  // Keyed by what the rows say: only a change in what the palette would list may
  // re-register the owner.
  const signature = rows.map((row) => `${row.runId} ${row.control} ${row.title}`).join("|");
  // Built from this render's rows, not through a ref, which a layout effect refreshes only
  // after this memo runs. The signature is the dependency because keying on the array's
  // identity would re-register commands on every streamed run event.
  const commands = useMemo(
    () => rows.map((row) => buildRunControlCommand(row, inputRef)),
    [signature, inputRef],
  );

  useRegisterCommands(RUN_CONTROL_COMMAND_OWNER, commands);
}

/**
 * One command, closed over nothing that moves: the ref is read inside `run`, so a press
 * dispatches against the version the stream has reached, as the row's button does.
 */
function buildRunControlCommand(
  row: RunControlCommandRow,
  inputRef: React.RefObject<RunControlCommandInput>,
): CommandDefinition {
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
