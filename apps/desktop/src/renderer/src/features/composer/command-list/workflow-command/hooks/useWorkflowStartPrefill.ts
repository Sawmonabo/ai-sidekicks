// The palette entry's own act: putting the directive on the line without eating it. The palette
// has no line and so no name, so it prefills `/workflow start ` and asks for the caret; the
// command-line handler runs once the line is complete. `DraftStore.write` replaces the whole text
// with no history, so the write happens only into a blank line and otherwise waits for an explicit
// decision. Blankness is decided by trimming; the text itself is never trimmed.

import { useCallback, useMemo, useState } from "react";

import { useRegisterCommands } from "@renderer/registries/commands/hooks/useRegisterCommands.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import type { DraftStore } from "@renderer/store/draft-store.js";
import { requestComposerFocus } from "../../../composer-focus-requests.js";
import {
  WORKFLOW_COMMAND_ROOT,
  WORKFLOW_START_COMMAND_PREFILL,
} from "../workflow-command-grammar.js";

/** The owner this command is contributed under. One per feature, one live at a time. */
const WORKFLOW_START_COMMAND_OWNER = "composer-workflow-start";

/** What the palette entry's act resolves to for the line as it stands. */
export type WorkflowStartPrefillDecision =
  | { readonly status: "prefill" }
  | { readonly status: "confirm-replace"; readonly displacedText: string };

/** The pending decision a mounted composer is holding, and the two ways out of it. */
export interface WorkflowStartPrefillPrompt {
  /** The unsent text a prefill would replace, or nothing while none is pending. */
  readonly displacedText: string | undefined;
  /** Take the prefill and lose the text. Only reachable from the pending state. */
  readonly replaceLine: () => void;
  /** Keep the text and leave the line as it is. */
  readonly keepLine: () => void;
}

/** Decide what typing the directive onto this line would cost. Pure, so it is testable alone. */
export function decideWorkflowStartPrefill(currentText: string): WorkflowStartPrefillDecision {
  return currentText.trim().length === 0
    ? { status: "prefill" }
    : { status: "confirm-replace", displacedText: currentText };
}

/**
 * Contribute the palette entry for one mounted composer, and hold its one decision. The current
 * text is read at call time, not subscribed: a value closed over at render predates the last
 * keystroke.
 */
export function useWorkflowStartPrefill(options: {
  readonly draftStore: DraftStore;
  /** This composer's own line, which the palette entry types into. */
  readonly draftKey: string;
}): WorkflowStartPrefillPrompt {
  const { draftStore, draftKey } = options;
  const [displacedText, setDisplacedText] = useState<string | undefined>(undefined);

  const writePrefill = useCallback(() => {
    draftStore.write(draftKey, WORKFLOW_START_COMMAND_PREFILL);
    requestComposerFocus();
  }, [draftStore, draftKey]);

  const commands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: WORKFLOW_COMMAND_ROOT,
        title: "Start a workflow",
        group: "Workflow",
        when: "sessionActive",
        keywords: ["workflow", "start", "run"],
        run: () => {
          const decision = decideWorkflowStartPrefill(draftStore.read(draftKey)?.text ?? "");
          if (decision.status === "prefill") {
            writePrefill();
            return;
          }
          setDisplacedText(decision.displacedText);
        },
      },
    ],
    [draftStore, draftKey, writePrefill],
  );
  useRegisterCommands(WORKFLOW_START_COMMAND_OWNER, commands);

  const replaceLine = useCallback(() => {
    setDisplacedText(undefined);
    writePrefill();
  }, [writePrefill]);

  const keepLine = useCallback(() => {
    setDisplacedText(undefined);
    // The caret goes back to the line the person chose to keep typing.
    requestComposerFocus();
  }, []);

  return { displacedText, replaceLine, keepLine };
}
