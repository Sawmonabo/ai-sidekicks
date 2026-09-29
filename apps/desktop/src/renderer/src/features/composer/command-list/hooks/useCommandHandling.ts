// The send bar's command handling: the recognizer, the executor, and the published-name
// lookup it is handed about a typed `/name`, built in one place.

import { useCallback, useMemo } from "react";

import { useLatestRef } from "@renderer/console/primitives/index.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import type { CommandExecutor } from "../../types.js";
import type { ComposerTarget } from "../../composer-target.js";
import type {
  ClientCommandPredicate,
  ProviderCommandPredicate,
} from "../../draft-line/send-resolutions.js";
import { createClientCommandExecutor } from "../client-command-executor.js";
import { recognizeClientCommand } from "../client-command-recognizer.js";
import { addressedProviderBinding } from "../command-list-entries.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
} from "../composer-command-line-handlers.js";
import { readComposerCommands } from "../composer-commands.js";
import type { ProviderCommandEnumeration } from "../provider-command-enumeration.js";

/**
 * What the send bar is handed about a typed `/name`, built in one place.
 *
 * The first two travel TOGETHER because they are one decision split in half: the
 * router will not intercept a name nothing claims, so a recognizer with no executor
 * intercepts into a refusal and an executor with no recognizer is never called. Both
 * read the SAME surface thunk, so the predicate that claimed a name and the executor
 * that runs it can never be looking at two different registries.
 *
 * The third answers the OTHER question a typed name raises — whether the bound
 * provider published it — off the enumeration holder the discovery popover renders
 * from. One holder rather than a second read, so the list a person read the name off
 * and the path that refuses it are one reading.
 */
export interface CommandHandling {
  readonly recognizeClientCommand: ClientCommandPredicate;
  readonly commandExecutor: CommandExecutor;
  readonly recognizeProviderCommand: ProviderCommandPredicate;
}

/** Build the send bar's recognizer, executor, and discovery reading. */
export function useCommandHandling(options: {
  readonly route: AppRoute;
  readonly commandEnumeration: ProviderCommandEnumeration;
  /**
   * Where this composer is addressed, so the published-name lookup reads the
   * addressed run's own binding. An agent can hold several live bindings at once, and
   * a name published by one of the others is not a name this send path may recognize.
   */
  readonly target: ComposerTarget;
  /**
   * The commands that read arguments off the typed line. They close over what the
   * composer is addressed at, so they change between renders while the executor built
   * from them does not.
   */
  readonly commandLineHandlers: ComposerCommandLineHandlers;
}): CommandHandling {
  const { route, commandEnumeration, target, commandLineHandlers } = options;
  const readCommands = useCallback(() => readComposerCommands(route), [route]);
  const recognizeName = useCallback<ClientCommandPredicate>(
    (commandName) =>
      recognizeClientCommand(commandName, {
        registeredCommandIds: readCommands().registeredCommandIds,
      }).status === "recognized",
    [readCommands],
  );
  // The executor is memoized and outlives every render, so it reads the handlers through
  // the latest-ref at call time rather than closing over the ones it was built with.
  const handlersRef = useLatestRef(commandLineHandlers);
  const commandExecutor = useMemo(
    () =>
      createClientCommandExecutor({
        readCommands,
        readCommandLineHandlers: () => handlersRef.current,
        lineReadingCommandIds: LINE_READING_COMMAND_IDS,
      }),
    [readCommands, handlersRef],
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
