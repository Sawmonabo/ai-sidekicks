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

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  isErrorInstance,
  lossyStringify,
  readGuardedProperty,
} from "../../../../../shared/wire-errors.js";
import type { GrowthPort } from "../../../console/bridge/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import type { ConsoleRoute } from "../../../console/routing/index.js";
import type { CommandExecutor, CommandOutcome, DirectiveLine } from "../router/command-executor.js";
import type {
  ClientCommandPredicate,
  ProviderCommandPredicate,
} from "../router/send-resolutions.js";
import type { ProviderCommandEnumeration } from "./provider-command-holder.js";
import {
  clientCommandRefusal,
  recognizeClientCommand,
  type ClientCommandRecognitionInput,
} from "./client-command-recognizer.js";
import { composerCommandSurface, type ComposerCommandSurface } from "./console-command-surface.js";
import { addressedProviderBinding } from "./provider-command-catalog.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { DirectiveLineHandlers } from "./directive-line-handlers.js";
import { useWorkflowStartAccelerator } from "./workflow-start-accelerator.js";

/**
 * Build the executor for one composer.
 *
 * The surface is read through a THUNK rather than captured as a value: the frame
 * registers this window's commands from an effect that runs after the composer
 * mounts, so an executor holding a list captured at construction would refuse every
 * command in the window it was built in. The handlers are read through one for the
 * mirror-image reason: they close over what the composer is addressed at, which moves.
 */
export function createClientCommandExecutor(options: {
  readonly readSurface: () => ComposerCommandSurface;
  readonly readDirectiveHandlers: () => DirectiveLineHandlers;
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
    // Preferred over the registry's argument-free `invoke`, and only after the
    // recogniser has claimed the name: an argument-reading command performed through
    // `invoke` would run with the line thrown away.
    const handler = options.readDirectiveHandlers().get(recognition.commandId);
    if (handler !== undefined) {
      return await handler(line);
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
        //
        // NOT `normalizeWireRejection`, and the reason is what threw. A client
        // command runs IN THIS WINDOW — nothing crossed a wire, so there is no
        // daemon code to preserve, and letting a callback's thrown `code` become
        // the refusal's code would widen a closed composer vocabulary from outside
        // it. What is wanted here is one thing the thrown value can always give: a
        // sentence. The shared leaf helpers answer that and nothing else, so no
        // second stringifier is written and none of the wire machinery is invoked
        // on a value that never saw the wire.
        // Read guardedly and stringified totally, because this is the report path:
        // an `Error` subclass is free to define an accessor over `message`, and a
        // throw from inside the sentence that says something failed is the one
        // outcome this branch exists to prevent.
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
  /**
   * Where this composer is addressed, so the published-name lookup reads the
   * addressed run's own binding. An agent can hold several live bindings at once, and
   * a name published by one of the others is not a name this send path may recognise.
   */
  readonly target: ComposerTarget;
  /** The port the accelerators call. Theirs alone; nothing else in this zone asks. */
  readonly growth: GrowthPort;
  /** The session an accelerator starts work in, or nothing where there is none. */
  readonly sessionId: string | undefined;
  readonly draftStore: DraftStore;
  /** This composer's own line, which the workflow accelerator's palette entry types. */
  readonly draftKey: string;
}): ComposerCommandZone {
  const { route, commandEnumeration, target } = options;
  const readSurface = useCallback(() => composerCommandSurface(route), [route]);
  const recognizeName = useCallback<ClientCommandPredicate>(
    (commandName) =>
      recognizeClientCommand(commandName, {
        registeredCommandIds: readSurface().registeredCommandIds,
      }).status === "recognized",
    [readSurface],
  );
  // Read through a thunk for the same reason the surface is: an accelerator closes
  // over the session and the port this composer is addressed at, and both move under
  // a mounted composer.
  const directiveHandlers = useWorkflowStartAccelerator({
    growth: options.growth,
    sessionId: options.sessionId,
    draftStore: options.draftStore,
    draftKey: options.draftKey,
  });
  const handlersRef = useRef<DirectiveLineHandlers>(directiveHandlers);
  // Written from an effect and never during render. React's own rule is that a ref
  // is not touched while rendering — under a concurrent render that is thrown away,
  // a render-body write has already mutated state the committed tree keeps — and the
  // thunk below is what makes the effect sufficient: the handlers the executor reads
  // are resolved at call time rather than closed over at render time.
  //
  // A LAYOUT EFFECT, which is the standard shape for a latest-ref. A passive effect
  // is flushed AFTER paint, so between the commit that changed the handlers and that
  // flush there is a window in which the committed tree is on screen and the ref
  // still holds the previous render's value. Nothing here yields inside that window
  // today — a person cannot type between paint and the passive flush — but the claim
  // "never a render behind" is then a property of what a browser happens to schedule
  // rather than of this hook. `useLayoutEffect` runs synchronously before paint, so
  // the ref is current the moment the tree that produced it is, and the claim holds
  // on its own. The write is one assignment, so the synchronous phase costs nothing.
  useLayoutEffect(() => {
    handlersRef.current = directiveHandlers;
  }, [directiveHandlers]);
  const commandExecutor = useMemo(
    () =>
      createClientCommandExecutor({
        readSurface,
        readDirectiveHandlers: () => handlersRef.current,
      }),
    [readSurface],
  );
  const addressed = useMemo(() => addressedProviderBinding(target), [target]);
  const recognizePublished = useCallback<ProviderCommandPredicate>(
    (commandName) => commandEnumeration.publishedEntryNamed(commandName, addressed),
    [commandEnumeration, addressed],
  );
  return {
    recognizeClientCommand: recognizeName,
    commandExecutor,
    recognizeProviderCommand: recognizePublished,
  };
}
