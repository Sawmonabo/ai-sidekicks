// One shell on screen: its lease line, its emulator fed with its live output, the line saying its
// program exited, and the line saying why its stream, a write or a size was refused. A shell that
// did not start draws only its cause with `Try again`.
//
// The write gate opens on the lease folded from the shell list's holder and the session's standing
// events against this device's id, once the pane's own output feed is followed, since every write
// is bound to its subscription; through a re-open what is typed waits for the new one. Until this
// device's id is known another device's hold, or this device's own, reads as not yet read and the
// body stays read-only. A shell whose program exited takes no input. Only while this device holds
// the shell is its grid's size handed to the shell.

import { useEffect, useMemo, useState } from "react";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import { useMainProcessState } from "#renderer/store/window/hooks/useMainProcessState.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { XtermMountPoint } from "../../emulator/components/XtermMountPoint.js";
import type { TerminalGridSize } from "../../emulator/xterm/adapter.js";
import { LeaseLine } from "../../lease/components/LeaseLine.js";
import { useStopRun } from "../../lease/hooks/useStopRun.js";
import { useTakeShell } from "../../lease/hooks/useTakeShell.js";
import {
  canTypeIntoShell,
  projectTerminalLease,
  type TerminalLeaseState,
} from "../../lease/state.js";
import { useShellOutput } from "../hooks/useShellOutput.js";

/** The shell body's accessible name. */
const TERMINAL_OUTPUT_LABEL = "Shell output";

/** The shell to show, the bridge its streams ride, the stores its lease is read from. */
export interface ShellBodyProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
  readonly shell: TerminalListEntry;
  /** Opens a fresh shell in place of one that did not start. */
  readonly onTryAgain: () => void;
}

/** One shell's lease line, live emulator, exit line and refusal line, or why it did not start. */
export function ShellBody(props: ShellBodyProps): React.JSX.Element {
  const { shell, onTryAgain } = props;
  if (shell.status.state === "didNotStart") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title={`The shell did not start · ${shell.status.cause}`}
        action={<TryAgainButton onPress={onTryAgain} />}
      />
    );
  }
  return <StartedShellBody {...props} />;
}

function StartedShellBody(props: ShellBodyProps): React.JSX.Element {
  const { bridge, sessionId, sessionStore, frameStore, shell } = props;
  const { terminalId, status } = shell;
  const standingEvents = useSessionStore(sessionStore, selectStandingEvents);
  const thisDeviceId = useMainProcessState(frameStore).negotiation?.deviceId;
  const output = useShellOutput(bridge, { sessionId, terminalId });
  const [gridSize, setGridSize] = useState<TerminalGridSize | undefined>(undefined);

  // The selector returns the stored array, so the fold reruns only when its identity changes.
  const lease: TerminalLeaseState = useMemo(
    () =>
      projectTerminalLease(standingEvents, {
        terminalId,
        thisDeviceId,
        listedLease: { holder: shell.holder, leaseVersion: shell.leaseVersion },
      }),
    [terminalId, thisDeviceId, standingEvents, shell.holder, shell.leaseVersion],
  );
  const { outputSubscriptionId, resizeShell } = output;
  const isHeldHere = lease.holder === "held-by-this-device";
  const hasExited = status.state === "exited";

  // A take moves the hold here, so the size goes again then even if the grid did not change.
  useEffect(() => {
    if (isHeldHere && !hasExited && gridSize !== undefined) {
      resizeShell(gridSize);
    }
  }, [isHeldHere, hasExited, gridSize, resizeShell]);

  return (
    <>
      {outputSubscriptionId === undefined ? null : (
        <ShellLeaseLine
          bridge={bridge}
          sessionId={sessionId}
          shell={shell}
          outputSubscriptionId={outputSubscriptionId}
          lease={lease}
        />
      )}
      <XtermMountPoint
        terminalId={terminalId}
        isWriteEnabled={canTypeIntoShell(lease.holder) && output.isFollowing && !hasExited}
        label={TERMINAL_OUTPUT_LABEL}
        onKeystroke={output.typeKeys}
        onPaste={output.pasteText}
        onGridResize={setGridSize}
        openOutput={output.openOutput}
      />
      {status.state === "exited" ? (
        <p className="meridian-terminal-pane__exit-line">
          {`Exited with code ${String(status.exitCode)}`}
        </p>
      ) : null}
      {output.refusal === undefined ? null : (
        <InlineRefusal code={output.refusal.code} detail={output.refusal.detail} />
      )}
    </>
  );
}

// The take is bound to the pane's own output subscription, so the line is drawn once it is open.
// No reader of a holding device's or agent's name exists yet, so the line draws nothing until one
// is wired in.
function ShellLeaseLine(props: {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly shell: TerminalListEntry;
  readonly outputSubscriptionId: SubscriptionId;
  readonly lease: TerminalLeaseState;
}): React.JSX.Element | null {
  const { bridge, sessionId, shell, outputSubscriptionId, lease } = props;
  const takeShell = useTakeShell(
    bridge,
    { sessionId, terminalId: shell.terminalId, outputSubscriptionId },
    lease.holderDeviceId,
  );
  const stopRun = useStopRun(bridge, sessionId, lease.holderCommandId);
  return <LeaseLine state={lease} holderName={undefined} takeShell={takeShell} stopRun={stopRun} />;
}
