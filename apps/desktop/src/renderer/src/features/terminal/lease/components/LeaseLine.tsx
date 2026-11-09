// The lease line: who holds one of the session's shells, the take control beside it, and why a
// take was refused. It states the holder from the fold and never derives it from a take: the line
// moves when a `terminal.control.changed` transition reaches the fold. Nothing is drawn until the
// holder and its name have been read, while nobody holds the shell, or while this device does. A
// run's hold is named by the run's agent, read off the session's agent list. The take is offered
// only against another device's hold; a run's hold is never taken, and carries `Stop the run`,
// which stops the holding command.

import "./LeaseLine.css";

import { useId } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { useHoldingAgentName } from "../hooks/useHoldingAgentName.js";
import type { UseStopRunResult } from "../hooks/useStopRun.js";
import type { UseTakeShellResult } from "../hooks/useTakeShell.js";
import { isLeaseLineDrawn, type TerminalLeaseState } from "../state.js";
import { LeaseHolderSentence } from "./LeaseHolderSentence.js";
import { LeaseTakeControl } from "./LeaseTakeControl.js";

/**
 * What the lease line shows: the folded holder, the device's name or where the run's agent is read
 * from, and the take or stop for the shell.
 */
export interface LeaseLineProps {
  readonly bridge: PlatformBridge;
  /** The shell's session, whose runs name the agent a run's hold is worded with. */
  readonly sessionStore: SessionStore;
  readonly state: TerminalLeaseState;
  /** The holding device's name; `undefined` until read. */
  readonly deviceName: string | undefined;
  readonly takeShell: UseTakeShellResult;
  /** The stop of the holding command, `undefined` while no run's command holds the shell. */
  readonly stopRun: UseStopRunResult | undefined;
}

/** The lease line: the holder sentence, the take or stop control and its refusal, or nothing. */
export function LeaseLine(props: LeaseLineProps): React.JSX.Element | null {
  const { bridge, sessionStore, state, deviceName, takeShell, stopRun } = props;
  const questionId = useId();
  const agentName = useHoldingAgentName(bridge, sessionStore, state.holderRunId);
  const { holder } = state;
  const holderName = holder === "held-by-run" ? agentName : deviceName;
  if (!isLeaseLineDrawn(holder) || holderName === undefined) {
    return null;
  }
  const isTakeOffered = holder === "held-by-another-device";
  const runStop = holder === "held-by-run" ? stopRun : undefined;

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
        {runStop === undefined ? null : (
          <button
            type="button"
            className="meridian-clickable-word"
            aria-disabled={runStop.isInFlight}
            onClick={runStop.stop}
          >
            Stop the run
          </button>
        )}
      </div>
      {isTakeOffered && takeShell.refusal !== undefined ? (
        <InlineRefusal code={takeShell.refusal.code} detail={takeShell.refusal.detail} />
      ) : null}
      {runStop?.refusal === undefined ? null : (
        <InlineRefusal code={runStop.refusal.code} detail={runStop.refusal.detail} />
      )}
    </div>
  );
}
