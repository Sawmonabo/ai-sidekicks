// The question a close asks in place, under the strip, before it ends a shell another of the
// person's devices holds: `Close` ends it there too, `Cancel` or Escape keeps it. Its focus lands on
// `Close` as it opens, so the answer is one key away.

import { useId } from "react";

import type { TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { useInlineConfirm } from "#renderer/hooks/useInlineConfirm.js";

/** The held shells the close asks about, and where the person's answer goes. */
export interface CloseShellQuestionProps {
  readonly heldShells: readonly TerminalListEntry[];
  readonly onAnswer: (isConfirmed: boolean) => void;
}

/** The line asking whether to close shells another device holds, with `Cancel` and `Close`. */
export function CloseShellQuestion(props: CloseShellQuestionProps): React.JSX.Element {
  const { heldShells, onAnswer } = props;
  const questionId = useId();
  const confirm = useInlineConfirm(() => {
    onAnswer(false);
  }, "last-button");
  return (
    <div className="meridian-terminal-pane__close-question">
      <span id={questionId}>{questionOf(heldShells)}</span>
      <div
        ref={confirm.ref}
        className="meridian-terminal-pane__close-answers"
        role="group"
        aria-labelledby={questionId}
        onKeyDown={confirm.onKeyDown}
      >
        <button
          type="button"
          className="meridian-action-button meridian-action-button--regular meridian-action-button--outline"
          onClick={() => {
            onAnswer(false);
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="meridian-action-button meridian-action-button--regular meridian-accent-fill"
          onClick={() => {
            onAnswer(true);
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// One shell is named by its tab's title; several are counted.
function questionOf(heldShells: readonly TerminalListEntry[]): string {
  const [onlyShell] = heldShells;
  return heldShells.length === 1 && onlyShell !== undefined
    ? `Another device holds ${onlyShell.title}. Close it?`
    : `Another device holds ${String(heldShells.length)} of these shells. Close them?`;
}
