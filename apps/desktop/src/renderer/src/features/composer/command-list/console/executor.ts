// Runs one recognized command and waits for it before the line is cleared. The registry's
// `invoke` hands back its command's promise without awaiting it, so this is the one place that
// spends `completion` and answers with a settlement rather than a start. Every arm settles and
// none throws, including a rejecting command handler: the send controller awaits under
// a `finally` with no `catch`, so an escaping rejection would show no refusal. A command that
// fails is stated on the window's banner, as one run from the palette or a chord is, and the line
// stays as typed. A command that does not run here settles as `send-as-typed`, so the provider
// answers the line, not the console.

import type { CommandDefinition } from "#renderer/registries/commands/definition.js";
import { stateCommandFailure } from "#renderer/registries/commands/refusal.js";
import type { CommandExecutor, CommandOutcome, ComposerCommandLine } from "../../types.js";
import { CONSOLE_COMMAND_REFUSAL_ORIGIN } from "./recognizer.js";
import { type ComposerCommands } from "../registry-view.js";
import { type ComposerCommandLineHandlers } from "../line-handlers.js";

/**
 * Build the executor for one composer. Commands and handlers are read through thunks: the
 * frame registers this window's commands after the composer mounts, and the handlers close
 * over the composer's address, which moves.
 */
export function createConsoleCommandExecutor(options: {
  readonly readCommands: () => ComposerCommands;
  readonly readCommandLineHandlers: () => ComposerCommandLineHandlers;
  /**
   * Commands that read their arguments off the typed line. One with no handler settles as
   * `not-run`; the argument-free registry act would report `applied` for a dropped line.
   */
  readonly lineReadingCommandIds: readonly string[];
}): CommandExecutor {
  return async (line: ComposerCommandLine): Promise<CommandOutcome> => {
    const commands = options.readCommands();
    const command = commands.runnableCommands.find(
      (candidate) => candidate.id === line.commandName,
    );
    if (command === undefined) {
      // The registry changed since the router claimed the name or the list was drawn.
      return { status: "send-as-typed" };
    }
    // Preferred over the argument-free `invoke`, and only after the name was found: an
    // argument-reading command run through `invoke` would drop the line.
    const handler = options.readCommandLineHandlers().get(command.id);
    if (handler !== undefined) {
      try {
        // Called inside the boundary so a handler that throws synchronously and one that
        // returns a rejected promise are both caught.
        return await handler(line);
      } catch (cause) {
        // A handler is reached through an executor that never throws to report a failure, so
        // it settles here as a registered command's own failure would.
        return commandFailure(command, cause);
      }
    }
    if (options.lineReadingCommandIds.includes(command.id)) {
      return { status: "not-run" };
    }
    return await settleInvocation(commands, command);
  };
}

/** One invocation, resolved into exactly one settlement. Never throws. */
async function settleInvocation(
  composerCommands: ComposerCommands,
  command: CommandDefinition,
): Promise<CommandOutcome> {
  const outcome = composerCommands.invoke(command.id);
  switch (outcome.status) {
    case "unknown-command":
    case "hidden-in-context":
    case "unavailable":
      return { status: "send-as-typed" };
    case "ran":
      try {
        await outcome.completion;
        return { status: "applied" };
      } catch (cause) {
        return commandFailure(command, cause);
      }
  }
}

/**
 * A console command's own failure from either path into an act, stated on the window's banner;
 * the line stays as typed and the composer draws nothing beside it.
 */
function commandFailure(command: CommandDefinition, cause: unknown): CommandOutcome {
  stateCommandFailure(CONSOLE_COMMAND_REFUSAL_ORIGIN, command, cause);
  return { status: "not-run" };
}
