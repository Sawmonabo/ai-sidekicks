// The send bar's command handling: the recognizer and the executor it is handed about a typed
// `/name`, built in one place.

import { useCallback, useMemo } from "react";

import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import type { CommandExecutor } from "../../types.js";
import type { ConsoleCommandPredicate } from "../../draft-line/send-resolutions.js";
import { createConsoleCommandExecutor } from "../console-command-executor.js";
import { recognizeConsoleCommand } from "../console-command-recognizer.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
} from "../composer-command-line-handlers.js";
import { readComposerCommands } from "../composer-commands.js";

/**
 * What the send bar is handed about a typed `/name`. The recognizer and executor read the same
 * commands thunk, so a name one claims is never run against another registry.
 */
export interface CommandHandling {
  readonly recognizeConsoleCommand: ConsoleCommandPredicate;
  readonly commandExecutor: CommandExecutor;
}

/** Build the send bar's recognizer and executor. */
export function useCommandHandling(options: {
  readonly route: AppRoute;
  readonly commandLineHandlers: ComposerCommandLineHandlers;
}): CommandHandling {
  const { route, commandLineHandlers } = options;
  const readCommands = useCallback(() => readComposerCommands(route), [route]);
  const recognizeName = useCallback<ConsoleCommandPredicate>(
    (commandName) =>
      recognizeConsoleCommand(commandName, {
        runnableCommandIds: readCommands().runnableCommandIds,
      }),
    [readCommands],
  );
  // The executor is memoized and outlives every render, so it reads the handlers through
  // the latest-ref at call time rather than closing over the ones it was built with.
  const handlersRef = useLatestRef(commandLineHandlers);
  const commandExecutor = useMemo(
    () =>
      createConsoleCommandExecutor({
        readCommands,
        readCommandLineHandlers: () => handlersRef.current,
        lineReadingCommandIds: LINE_READING_COMMAND_IDS,
      }),
    [readCommands, handlersRef],
  );
  return { recognizeConsoleCommand: recognizeName, commandExecutor };
}
