// Running one recognised command, and waiting for it before the line is cleared.
//
// THE WHOLE POINT IS THE AWAIT. The send controller clears the input on an
// interception because "the act happened, and nothing was sent". That sentence is
// only true if something actually ran — and the registry's `invoke` is deliberately
// synchronous, handing its command's promise back rather than awaiting it, because a
// keybinding dispatch must not block the key handler. A composer that took `invoke`'s
// return as settlement would clear a person's typed line on a command that had not
// started, could not be offered here, or rejected a beat later.
//
// So this module is the one place that spends the `completion` promise `invoke`
// returns, and it answers with a settlement rather than a start.
//
// EVERY ARM SETTLES, AND EACH SETTLES DIFFERENTLY. `unknown-command` is a name the
// registry no longer holds; `hidden-in-context` is a command that exists and does not
// apply where this composer is — two different remedies, so two different codes. A
// rejected `completion` is a third: the command ran and failed, and the honest report
// is the command's own failure rather than a claim that it was never recognised.
//
// AND THE DIRECTIVE-LINE HANDLER IS INSIDE THAT GUARANTEE RATHER THAN BESIDE IT. The
// seam's own contract is that an executor returns a settlement and never throws to
// report one; a handler reached through this module is reached through that promise,
// so a handler that rejected broke the contract from the inside. The send controller
// awaits this call under a `finally` and no `catch`, so such a rejection reached a
// person as no refusal at all. Both paths into an act now settle through one report.

import { isErrorInstance, lossyStringify, readGuardedProperty } from "@renderer/lib/wire-errors.js";
import type { CommandExecutor, CommandOutcome, ComposerCommandLine } from "../types.js";
import {
  clientCommandRefusal,
  recognizeClientCommand,
  type ClientCommandRecognitionInput,
} from "./client-command-recognizer.js";
import { type ComposerCommands } from "./composer-commands.js";
import { type ComposerCommandLineHandlers } from "./composer-command-line-handlers.js";

/**
 * Build the executor for one composer.
 *
 * The commands are read through a THUNK rather than captured as a value: the frame
 * registers this window's commands from an effect that runs after the composer
 * mounts, so an executor holding a list captured at construction would refuse every
 * command in the window it was built in. The handlers are read through one for the
 * mirror-image reason: they close over what the composer is addressed at, which moves.
 */
export function createClientCommandExecutor(options: {
  readonly readCommands: () => ComposerCommands;
  readonly readCommandLineHandlers: () => ComposerCommandLineHandlers;
  /**
   * The commands that read their arguments off the typed line. One of these with no
   * handler in the map settles as `not-run` rather than through the argument-free
   * registry act, which would report `applied` for a line whose arguments it dropped.
   */
  readonly lineReadingCommandIds: readonly string[];
}): CommandExecutor {
  return async (line: ComposerCommandLine): Promise<CommandOutcome> => {
    const commands = options.readCommands();
    const recognitionInput: ClientCommandRecognitionInput = {
      registeredCommandIds: commands.registeredCommandIds,
    };
    const recognition = recognizeClientCommand(line.commandName, recognitionInput);
    if (recognition.status === "refused") {
      return { status: "refused", refusal: recognition.refusal };
    }
    // Preferred over the registry's argument-free `invoke`, and only after the
    // recogniser has claimed the name: an argument-reading command performed through
    // `invoke` would run with the line thrown away.
    const handler = options.readCommandLineHandlers().get(recognition.commandId);
    if (handler !== undefined) {
      try {
        // CALLED INSIDE THE BOUNDARY rather than awaited from outside it, on
        // `palette/commands/bridge-commands.ts`'s own reasoning: a handler that throws
        // synchronously and one that returns a rejected promise are the same failure
        // to the person who typed the line, and only this placement catches both.
        return await handler(line);
      } catch (cause) {
        // The contract this seam declares is that an executor "returns a settlement;
        // never throws to report one", and a handler is reached THROUGH it — so an
        // escaping rejection was the composer's contract broken from the inside. The
        // send controller's interception arm has a `finally` and no `catch`, so what
        // reached a person was an unhandled rejection: no refusal beside the line,
        // and the line left in an unexplained state. It settles here, through the
        // same report a registered command's own failure takes.
        return commandFailureRefusal(recognition.commandId, cause);
      }
    }
    if (options.lineReadingCommandIds.includes(recognition.commandId)) {
      return { status: "not-run" };
    }
    return await settleInvocation(commands, recognition.commandId);
  };
}

/** One invocation, resolved into exactly one settlement. Never throws. */
async function settleInvocation(
  surface: ComposerCommands,
  commandId: string,
): Promise<CommandOutcome> {
  const outcome = surface.invoke(commandId);
  switch (outcome.status) {
    case "unknown-command":
      // Reachable even though the recognizer just read the list: the registry is
      // mutated by the frame's own registration lifecycle, and a command unregistered
      // between the read and the call is a real race rather than a hypothetical one.
      return {
        status: "refused",
        refusal: clientCommandRefusal(
          "unknown-command",
          `${commandId} is no longer registered in this window, so there was nothing to run.`,
        ),
      };
    case "hidden-in-context":
      return {
        status: "refused",
        refusal: clientCommandRefusal(
          "command-unavailable-here",
          `${commandId} does not apply where this composer is, so it was not run.`,
        ),
      };
    case "unavailable":
      // The owner's own sentence, carried through rather than paraphrased. This zone
      // knows a command was closed and never why; the family that closed it does.
      return {
        status: "refused",
        refusal: clientCommandRefusal("command-unavailable-now", outcome.reason),
      };
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
 * The report a client command's own failure takes, wherever it was reached from.
 *
 * ONE BUILDER FOR BOTH PATHS. The registry's `invoke` and the command-line handler
 * map are two ways into one act, and a person meeting a failure on either is owed the
 * same sentence under the same code — two copies of this reading would be two accounts
 * of one thing the day either was tuned.
 *
 * The command's own failure, carried rather than paraphrased. A command that renders
 * its own refusal has already done so; this is what keeps the LINE from being cleared
 * as though the act had succeeded.
 *
 * NOT `normalizeWireRejection`, and the reason is what threw. A client command runs IN
 * THIS WINDOW — nothing crossed a wire, so there is no daemon code to preserve, and
 * letting a callback's thrown `code` become the refusal's code would widen a closed
 * composer vocabulary from outside it. What is wanted here is one thing the thrown
 * value can always give: a sentence. The shared leaf helpers answer that and nothing
 * else, so no second stringifier is written and none of the wire machinery is invoked
 * on a value that never saw the wire.
 *
 * Read guardedly and stringified totally, because this is the report path: an `Error`
 * subclass is free to define an accessor over `message`, and a throw from inside the
 * sentence that says something failed is the one outcome this exists to prevent.
 */
function commandFailureRefusal(commandId: string, cause: unknown): CommandOutcome {
  const thrownMessage = readGuardedProperty(cause, "message");
  const failureMessage =
    isErrorInstance(cause) && typeof thrownMessage === "string"
      ? thrownMessage
      : lossyStringify(cause);
  return {
    status: "refused",
    refusal: clientCommandRefusal(
      "command-failed",
      `${commandId} did not complete: ${failureMessage}`,
    ),
  };
}
