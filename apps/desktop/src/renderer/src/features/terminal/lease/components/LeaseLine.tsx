// The lease line: who holds one of the session's shells, the take control beside it, and why a
// take was refused. It states the holder from the fold and never derives it from a take: the line
// moves when a `pty.control_changed` transition reaches the fold. Nothing is drawn until the
// holder and its name have been read, while nobody holds the shell, or while this device does.
// The take is offered only against another device's hold; a run's hold is never taken.

import "./LeaseLine.css";

import { useId } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { UseTakeShellResult } from "../hooks/useTakeShell.js";
import { isLeaseLineDrawn, type TerminalLeaseState } from "../state.js";
import { LeaseHolderSentence } from "./LeaseHolderSentence.js";
import { LeaseTakeControl } from "./LeaseTakeControl.js";

/** What the lease line shows: the folded holder, its name, and the take for the same shell. */
export interface LeaseLineProps {
  readonly state: TerminalLeaseState;
  /** The holding device's name, or the holding run's agent's name; `undefined` until read. */
  readonly holderName: string | undefined;
  readonly takeShell: UseTakeShellResult;
}

/** The lease line: the holder sentence, the take control and its refusal, or nothing. */
export function LeaseLine(props: LeaseLineProps): React.JSX.Element | null {
  const { state, holderName, takeShell } = props;
  const questionId = useId();
  const { holder } = state;
  if (!isLeaseLineDrawn(holder) || holderName === undefined) {
    return null;
  }
  const isTakeOffered = holder === "held-by-another-device";

  return (
    <div className="meridian-terminal-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-terminal-lease-line__head">
        <LeaseHolderSentence
          id={questionId}
          holder={holder}
          holderName={holderName}
          isConfirming={isTakeOffered && takeShell.isConfirming}
        />
        {isTakeOffered ? <LeaseTakeControl takeShell={takeShell} questionId={questionId} /> : null}
      </div>
      {isTakeOffered && takeShell.refusal !== undefined ? (
        <InlineRefusal code={takeShell.refusal.code} detail={takeShell.refusal.detail} />
      ) : null}
    </div>
  );
}
