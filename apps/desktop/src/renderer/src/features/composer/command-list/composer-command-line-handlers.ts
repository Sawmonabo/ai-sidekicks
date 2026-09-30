// The seam between a command that reads its line and the executor that runs it: the handler-map
// type and the ids it covers, shared by the executor that reads the map and the code building it.

import type { CommandOutcome, ComposerCommandLine } from "../types.js";
import { WORKFLOW_COMMAND_ROOT } from "./workflow-command/workflow-command-grammar.js";

/**
 * Handlers for commands that read arguments off the typed line, keyed by the registry's command id.
 * The registry's `run()` takes no line, so such a command is reached here. A handler for an id the
 * registry lacks is unreachable: the recognizer refuses the name first.
 */
export type ComposerCommandLineHandlers = ReadonlyMap<
  string,
  (line: ComposerCommandLine) => Promise<CommandOutcome>
>;

/**
 * The commands that read their arguments off the typed line. One typed with no handler in the map
 * is not run, because the palette act would run it with the arguments thrown away.
 */
export const LINE_READING_COMMAND_IDS: readonly string[] = [WORKFLOW_COMMAND_ROOT];

/**
 * An empty handler map for an executor built where no line exists. The discovery popover runs a
 * picked entry, which carries no typed argument, so an argument-reading command takes its palette
 * act. A function, not a constant, so no importer shares one map object.
 */
export function noComposerCommandLineHandlers(): ComposerCommandLineHandlers {
  return new Map();
}
