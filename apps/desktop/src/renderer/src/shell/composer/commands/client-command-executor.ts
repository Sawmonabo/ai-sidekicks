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

import { useCallback, useMemo } from "react";

import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import type { ConsoleRoute } from "../../../console/routing/index.js";
import type { CommandExecutor, CommandOutcome, DirectiveLine } from "../router/command-executor.js";
import type { ClientCommandPredicate, ProviderCommandPredicate } from "../router/send-router.js";
import type { ProviderCommandEnumeration } from "./provider-command-holder.js";
import {
  clientCommandRefusal,
  recognizeClientCommand,
  type ClientCommandRecognitionInput,
} from "./client-command-recognizer.js";
import { composerCommandSurface, type ComposerCommandSurface } from "./console-command-surface.js";

/**
 * Build the executor for one composer.
 *
 * The surface is read through a THUNK rather than captured as a value: the frame
 * registers this window's commands from an effect that runs after the composer
 * mounts, so an executor holding a list captured at construction would refuse every
 * command in the window it was built in.
 */
export function createClientCommandExecutor(options: {
  readonly readSurface: () => ComposerCommandSurface;
}): CommandExecutor {
  return async (line: DirectiveLine): Promise<CommandOutcome> => {
    const surface = options.readSurface();
    const recognitionInput: ClientCommandRecognitionInput = {
      registeredCommandIds: surface.registeredCommandIds,
    };
    const recognition = recognizeClientCommand(line.commandName, recognitionInput);
    if (recognition.status === "refused") {
      return { status: "refused", refusal: recognition.refusal };
    }
    return await settleInvocation(surface, recognition.commandId);
  };
}

/** One invocation, resolved into exactly one settlement. Never throws. */
async function settleInvocation(
  surface: ComposerCommandSurface,
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
    case "ran":
      try {
        await outcome.completion;
        return { status: "applied" };
      } catch (cause) {
        // The command's own failure, carried rather than paraphrased. A command that
        // renders its own refusal has already done so; this is what keeps the LINE
        // from being cleared as though the act had succeeded.
        const failure = normalizeWireRejection(cause, { total: true });
        return {
          status: "refused",
          refusal: clientCommandRefusal(
            "command-failed",
            `${commandId} did not complete: ${failure.message}`,
          ),
        };
      }
  }
}

/**
 * What the send bar is handed about a typed `/name`, built in one place.
 *
 * The first two travel TOGETHER because they are one decision split in half: the
 * router will not intercept a name nothing claims, so a recogniser with no executor
 * intercepts into a refusal and an executor with no recogniser is never called. Both
 * read the SAME surface thunk, so the predicate that claimed a name and the executor
 * that runs it can never be looking at two different registries.
 *
 * The third answers the OTHER question a typed name raises — whether the bound
 * provider published it — off the enumeration holder the discovery popover renders
 * from. One holder rather than a second read, so the list a person read the name off
 * and the path that refuses it are one reading.
 */
export interface ComposerCommandZone {
  readonly recognizeClientCommand: ClientCommandPredicate;
  readonly commandExecutor: CommandExecutor;
  readonly recognizeProviderCommand: ProviderCommandPredicate;
}

/** Build the send bar's recogniser, executor, and discovery reading. */
export function useComposerCommandZone(options: {
  readonly route: ConsoleRoute;
  readonly commandEnumeration: ProviderCommandEnumeration;
}): ComposerCommandZone {
  const { route, commandEnumeration } = options;
  const readSurface = useCallback(() => composerCommandSurface(route), [route]);
  const recognizeName = useCallback<ClientCommandPredicate>(
    (commandName) =>
      recognizeClientCommand(commandName, {
        registeredCommandIds: readSurface().registeredCommandIds,
      }).status === "recognized",
    [readSurface],
  );
  const commandExecutor = useMemo(
    () => createClientCommandExecutor({ readSurface }),
    [readSurface],
  );
  const recognizePublished = useCallback<ProviderCommandPredicate>(
    (commandName) => commandEnumeration.publishedEntryNamed(commandName),
    [commandEnumeration],
  );
  return {
    recognizeClientCommand: recognizeName,
    commandExecutor,
    recognizeProviderCommand: recognizePublished,
  };
}
