// The workflow command's line handler, keyed for the composer's executor.

import { useMemo } from "react";

import type { ComposerCommandLine } from "#renderer/features/composer/types.js";
import type { ComposerCommandLineHandlers } from "../../composer-command-line-handlers.js";
import { WORKFLOW_COMMAND_ROOT } from "../grammar.js";
import { startWorkflowFromLine, type WorkflowStartInput } from "../start-workflow-from-line.js";

/**
 * The command-line handler this composer's executor prefers over `invoke`, keyed by the root id
 * so the map cannot claim a name the console has never heard of.
 */
export function useWorkflowStartHandlers(input: WorkflowStartInput): ComposerCommandLineHandlers {
  const { operations, sessionId } = input;
  return useMemo(
    () =>
      new Map([
        [
          WORKFLOW_COMMAND_ROOT,
          (line: ComposerCommandLine) => startWorkflowFromLine(line, { operations, sessionId }),
        ],
      ]),
    [operations, sessionId],
  );
}
