// The composer's view of the console's command registry: what it may offer and what it may run.
// It reads the window-scoped registry the palette reads, so `/name` and the palette agree. The
// `when` context is typed `WindowWhenClauseContext`: a clause naming a key the context lacks
// evaluates false, so a hand-written context would silently hide commands.

import { type WindowWhenClauseContext } from "#renderer/registries/commands/when-clause/vocabulary.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { type CommandInvocationOutcome } from "#renderer/registries/commands/registry.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import type { AppRoute } from "#renderer/routing/routes.js";

/**
 * The narrow face of the console's command list the composer reads and acts through. Only what
 * runs here is listed and recognized: a command hidden or closed here is neither drawn in the
 * popover nor run when typed, and is sent as typed instead.
 */
export interface ComposerCommands {
  /** Every command offered where this composer is and not closed, ordered by group then title. */
  readonly runnableCommands: readonly CommandDefinition[];
  /** The ids of `runnableCommands`, which a typed name is recognized against. */
  readonly runnableCommandIds: readonly string[];
  /** Run one by id, fail-closed on visibility. Never awaits the command itself. */
  invoke(commandId: string): CommandInvocationOutcome;
}

/**
 * Read the console's commands as this composer's route sees them. Built per call, not memoized:
 * the frame registers commands after a child mounts, so a list captured at mount would stay empty.
 */
export function readComposerCommands(route: AppRoute): ComposerCommands {
  const whenContext = composerWhenContext(route);
  const runnableCommands = commandRegistry
    .commandsFor(whenContext)
    .filter((command) => command.unavailable === undefined);
  return {
    runnableCommands,
    runnableCommandIds: runnableCommands.map((command) => command.id),
    invoke: (commandId: string) => commandRegistry.invoke(commandId, whenContext),
  };
}

/**
 * Where a command run from the composer would be running. `sessionActive` is true because the
 * composer only renders inside a session; the three rail destinations are false because it does
 * not render on the sessions list, the workflows builder or settings. `transcriptHoldsRunGroup` is
 * false because the composer's list offers no transcript fold, and `paneFocused` because the
 * composer stands in the conversation, outside every pane.
 */
function composerWhenContext(route: AppRoute): WindowWhenClauseContext {
  return {
    sessionActive: true,
    onSessions: false,
    onSession: route.kind === "session",
    onWorkflows: false,
    onSettings: false,
    transcriptHoldsRunGroup: false,
    paneFocused: false,
  };
}
