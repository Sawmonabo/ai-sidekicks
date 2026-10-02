// Runs one recognized command and waits for it before the line is cleared. The registry's
// `invoke` hands back its command's promise without awaiting it, so this is the one place that
// spends `completion` and answers with a settlement rather than a start. Every arm settles and
// none throws, including a rejecting command handler: the send controller awaits under
// a `finally` with no `catch`, so an escaping rejection would show no refusal. A command that
// does not run here settles as `send-as-typed`, so the provider answers the line, not the console.

import { isErrorInstance, lossyStringify, readGuardedProperty } from "@renderer/lib/wire-errors.js";
import type { CommandExecutor, CommandOutcome, ComposerCommandLine } from "../types.js";
import { consoleCommandRefusal, recognizeConsoleCommand } from "./console-command-recognizer.js";
import { type ComposerCommands } from "./composer-commands.js";
import { type ComposerCommandLineHandlers } from "./composer-command-line-handlers.js";

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
    const commandId = line.commandName;
    if (!recognizeConsoleCommand(commandId, { runnableCommandIds: commands.runnableCommandIds })) {
      // The registry changed since the router claimed the name or the list was drawn.
      return { status: "send-as-typed" };
    }
    // Preferred over the argument-free `invoke`, and only after the recognizer claimed the
    // name: an argument-reading command run through `invoke` would drop the line.
    const handler = options.readCommandLineHandlers().get(commandId);
    if (handler !== undefined) {
      try {
        // Called inside the boundary so a handler that throws synchronously and one that
        // returns a rejected promise are both caught.
        return await handler(line);
      } catch (cause) {
        // A handler is reached through an executor that never throws to report a failure, so
        // it settles here as a registered command's own failure would.
        return commandFailureRefusal(commandId, cause);
      }
    }
    if (options.lineReadingCommandIds.includes(commandId)) {
      return { status: "not-run" };
    }
    return await settleInvocation(commands, commandId);
  };
}

/** One invocation, resolved into exactly one settlement. Never throws. */
async function settleInvocation(
  composerCommands: ComposerCommands,
  commandId: string,
): Promise<CommandOutcome> {
  const outcome = composerCommands.invoke(commandId);
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
        return commandFailureRefusal(commandId, cause);
      }
  }
}

/**
 * The report a console command's own failure takes from either path into an act, so a failure
 * reads the same under the same code. The command's message is carried, not paraphrased. Not
 * `normalizeWireRejection`: the command ran in this window, so no wire code exists to preserve
 * and a thrown `code` must not widen the closed refusal vocabulary. The message is read
 * guardedly because an `Error` subclass may define an accessor over it, and a throw here
 * would hide the failure being reported.
 */
function commandFailureRefusal(commandId: string, cause: unknown): CommandOutcome {
  const thrownMessage = readGuardedProperty(cause, "message");
  const failureMessage =
    isErrorInstance(cause) && typeof thrownMessage === "string"
      ? thrownMessage
      : lossyStringify(cause);
  return {
    status: "refused",
    refusal: consoleCommandRefusal(
      "command-failed",
      `${commandId} did not complete: ${failureMessage}`,
    ),
  };
}
