// The workflow command's line handler, keyed for the composer's executor.

import { useMemo } from "react";

import type { DirectiveLine } from "../../../types.js";
import type { DirectiveLineHandlers } from "../../composer-command-line-handlers.js";
import { WORKFLOW_COMMAND_ROOT } from "../workflow-command-grammar.js";
import { startWorkflowFromLine, type WorkflowStartInput } from "../start-workflow-from-line.js";

/**
 * The directive-line handler this composer's executor prefers over `invoke`.
 *
 * Keyed by the ROOT id, which is the id the recogniser claims and the palette lists,
 * so the map cannot claim a name the console has never heard of.
 */
export function useWorkflowStartHandlers(input: WorkflowStartInput): DirectiveLineHandlers {
  const { operations, sessionId } = input;
  return useMemo(
    () =>
      new Map([
        [
          WORKFLOW_COMMAND_ROOT,
          (line: DirectiveLine) => startWorkflowFromLine(line, { operations, sessionId }),
        ],
      ]),
    [operations, sessionId],
  );
}
