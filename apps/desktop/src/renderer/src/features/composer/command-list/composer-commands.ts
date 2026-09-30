// The composer's view of the console's command registry: what it may offer and what it may run.
// It reads the window-scoped registry the palette reads, so `/name` and the palette agree. The
// `when` context is typed `WindowWhenClauseContext`: a clause naming a key the context lacks
// evaluates false, so a hand-written context would silently hide commands.

import {
  commandRegistry,
  type WindowWhenClauseContext,
} from "@renderer/registries/commands/window-command-registry.js";
import { type CommandInvocationOutcome } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import type { AppRoute } from "@renderer/routing/routes.js";

/**
 * The narrow face of the console's command list the composer reads and acts through.
 * `offeredCommands` is what the popover may list; `registeredCommandIds` is every id this window
 * holds, visible or not, and a typed name is recognized against it so a command that exists but
 * does not apply here is not reported as unknown. Visibility still decides whether it runs.
 */
export interface ComposerCommands {
  /** Every command offered where this composer is, ordered by group then title. */
  readonly offeredCommands: readonly CommandDefinition[];
  /** Every command this window has registered, in registration order, visible or not. */
  readonly registeredCommandIds: readonly string[];
  /** Run one by id, fail-closed on visibility. Never awaits the command itself. */
  invoke(commandId: string): CommandInvocationOutcome;
}

/**
 * Read the console's commands as this composer's route sees them. Built per call, not memoized:
 * the frame registers commands after a child mounts, so a list captured at mount would stay empty.
 */
export function readComposerCommands(route: AppRoute): ComposerCommands {
  const whenContext = composerWhenContext(route);
  return {
    offeredCommands: commandRegistry.commandsFor(whenContext),
    registeredCommandIds: commandRegistry.all().map((command) => command.id),
    invoke: (commandId: string) => commandRegistry.invoke(commandId, whenContext),
  };
}

/**
 * Where a command run from the composer would be running. `sessionActive` is true because the
 * composer only renders inside a session; the three rail destinations are false because it does
 * not render on the sessions list, the workflows builder or settings.
 */
function composerWhenContext(route: AppRoute): WindowWhenClauseContext {
  return {
    sessionActive: true,
    onSessions: false,
    onSession: route.kind === "session",
    onWorkflows: false,
    onSettings: false,
  };
}
