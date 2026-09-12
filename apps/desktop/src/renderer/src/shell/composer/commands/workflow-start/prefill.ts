// The palette entry's own act: putting the directive on the line, without eating it.
//
// ONE COMMAND, TWO WAYS IN, AND NEITHER IS A COPY OF THE OTHER. The palette entry
// cannot start a run — there is no line there and so no name — so what it does is put
// the directive on the line and ask for the caret, which is the act a person who found
// the command in a list actually wants. The directive-line handler is what runs when
// the line is complete. Both are registered under the ROOT id, so the keyboard page,
// the discovery popover, and the recogniser are all naming one command.
//
// A PREFILL IS A WRITE, AND A WRITE OVER UNSENT TEXT IS A LOSS. `DraftStore.write`
// replaces the key's whole text and keeps no history, so a palette entry that wrote
// unconditionally destroyed whatever a person had typed and offered no way back — a
// command chosen by keyboard, one row away from another, with nothing between the
// press and the loss. So the write happens only into a line with nothing in it, and a
// line that holds something takes an EXPLICIT decision first: the text stands until
// the person says otherwise, and the surface that asks names what would go.
//
// BLANKNESS IS DECIDED BY TRIMMING AND THE TEXT IS NEVER TRIMMED. Whitespace alone is
// nothing a person would ask to keep, and the send router already decides emptiness
// the same way; what is preserved on the other arm is the user's own bytes.

import { useCallback, useMemo, useState } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../../../console/palette/index.js";
import type { DraftStore } from "../../../../console/persistence/index.js";
import { requestComposerFocus } from "../../../../console/seats/index.js";
import { WORKFLOW_COMMAND_ROOT, WORKFLOW_START_DIRECTIVE_PREFILL } from "./grammar.js";

/** The owner this command is contributed under. One per family, one live at a time. */
const WORKFLOW_START_COMMAND_OWNER = "composer-workflow-start";

/** What the palette entry's act resolves to for the line as it stands. */
export type WorkflowStartPrefillDecision =
  | { readonly status: "prefill" }
  | { readonly status: "confirm-replace"; readonly displacedText: string };

/**
 * Decide what typing the directive onto this line would cost.
 *
 * Pure, and separate from the writing, so the rule is drivable without a store, a
 * registry, or a React tree — the same split `send-router.ts` makes between resolving
 * and dispatching, and for the same reason.
 */
export function decideWorkflowStartPrefill(currentText: string): WorkflowStartPrefillDecision {
  return currentText.trim().length === 0
    ? { status: "prefill" }
    : { status: "confirm-replace", displacedText: currentText };
}

/** The pending decision a mounted composer is holding, and the two ways out of it. */
export interface WorkflowStartPrefillSurface {
  /** The unsent text a prefill would replace, or nothing while none is pending. */
  readonly displacedText: string | undefined;
  /** Take the prefill and lose the text. Only reachable from the pending state. */
  readonly replaceLine: () => void;
  /** Keep the text and leave the line as it is. */
  readonly keepLine: () => void;
}

/**
 * Contribute the palette entry for one mounted composer, and hold its one decision.
 *
 * The composer's LINE is what this half acts on, which is why it lives beside the
 * surface that watches the line rather than beside the send path that spends the
 * handler: the entry writes a draft and asks for the caret, and neither is something
 * the send bar does.
 *
 * The current text is read at CALL time rather than subscribed to: what the write
 * must not destroy is whatever is in the line when the row is pressed, and a value
 * closed over at render is a value from before the last keystroke.
 */
export function useWorkflowStartPrefill(options: {
  readonly draftStore: DraftStore;
  /** This composer's own line, which the palette entry types into. */
  readonly draftKey: string;
}): WorkflowStartPrefillSurface {
  const { draftStore, draftKey } = options;
  const [displacedText, setDisplacedText] = useState<string | undefined>(undefined);

  const writePrefill = useCallback(() => {
    draftStore.write(draftKey, WORKFLOW_START_DIRECTIVE_PREFILL);
    requestComposerFocus();
  }, [draftStore, draftKey]);

  const commands = useMemo<readonly ConsoleCommand[]>(
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
  useConsoleCommandSeat(WORKFLOW_START_COMMAND_OWNER, commands);

  const replaceLine = useCallback(() => {
    setDisplacedText(undefined);
    writePrefill();
  }, [writePrefill]);

  const keepLine = useCallback(() => {
    setDisplacedText(undefined);
    // The caret goes back where the person was: they answered a question about their
    // own line and the answer was to keep typing it.
    requestComposerFocus();
  }, []);

  return { displacedText, replaceLine, keepLine };
}
