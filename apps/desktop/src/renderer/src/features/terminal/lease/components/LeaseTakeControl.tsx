// The lease line's take control: `Take the shell`, which opens the confirm in place, and the
// confirm's `Cancel` and `Take it`. `Take it` takes focus when the confirm opens and Escape
// cancels it, and once it closes focus goes back to `Take the shell`. It never derives the holder
// from the take: the line moves when a `pty.control_changed` transition reaches the fold.

import { useEffect, useRef } from "react";

import { useInlineConfirm } from "#renderer/hooks/useInlineConfirm.js";
import type { UseTakeShellResult } from "../hooks/useTakeShell.js";

/** The take, and the id of the sentence that asks the confirm's question. */
export interface LeaseTakeControlProps {
  readonly takeShell: UseTakeShellResult;
  readonly questionId: string;
}

/** `Take the shell`, or the confirm's two buttons while it is open. */
export function LeaseTakeControl(props: LeaseTakeControlProps): React.JSX.Element {
  const { takeShell, questionId } = props;
  const takeShellButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(takeShell.isConfirming);

  useEffect(() => {
    if (wasConfirming.current && !takeShell.isConfirming) {
      takeShellButton.current?.focus();
    }
    wasConfirming.current = takeShell.isConfirming;
  }, [takeShell.isConfirming]);

  if (takeShell.isConfirming) {
    return <TakeShellConfirm takeShell={takeShell} questionId={questionId} />;
  }
  return (
    <button
      ref={takeShellButton}
      type="button"
      className="meridian-action-button meridian-action-button--regular meridian-lease-line__take"
      onClick={takeShell.openConfirm}
    >
      Take the shell
    </button>
  );
}

// Mounted only while the confirm is open, so its focus lands on `Take it` as it opens.
function TakeShellConfirm(props: LeaseTakeControlProps): React.JSX.Element {
  const { takeShell, questionId } = props;
  const confirm = useInlineConfirm(takeShell.cancelConfirm, "last-button");
  return (
    <div
      ref={confirm.ref}
      className="meridian-lease-line__controls"
      role="group"
      aria-labelledby={questionId}
      onKeyDown={confirm.onKeyDown}
    >
      <button
        type="button"
        className="meridian-action-button meridian-action-button--regular meridian-action-button--outline meridian-lease-line__confirm"
        disabled={takeShell.isInFlight}
        onClick={takeShell.cancelConfirm}
      >
        Cancel
      </button>
      <button
        type="button"
        className="meridian-action-button meridian-action-button--regular meridian-accent-fill meridian-lease-line__confirm"
        disabled={takeShell.isInFlight}
        onClick={takeShell.take}
      >
        Take it
      </button>
    </div>
  );
}
