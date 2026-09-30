// The send bar's command handling: the recognizer, the executor, and the published-name
// lookup it is handed about a typed `/name`, built in one place.

import { useCallback, useMemo } from "react";

import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
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
 * What the send bar is handed about a typed `/name`. The recognizer and executor read the same
 * commands thunk, so a name one claims is never run against another registry; the provider
 * predicate asks the enumeration holder the popover renders from whether the provider published it.
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
   * Where this composer is addressed, so the published-name lookup reads the addressed run's
   * binding: an agent can hold several live bindings, and another's name is not recognized here.
   */
  readonly target: ComposerTarget;
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
