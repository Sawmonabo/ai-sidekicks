// One shell on screen: its lease line, its emulator fed with its live output, and the line saying
// why its stream or a write was refused.
//
// The write gate opens on the lease folded from the shell list's holder and the session's standing
// events against this device's id, and only once the pane's own output subscription is open, since
// every write is bound to it. Until this device's id is known another device's hold, or this
// device's own, reads as not yet read and the body stays read-only.

import { useMemo } from "react";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import { useMainProcessState } from "#renderer/store/window/hooks/useMainProcessState.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { XtermMountPoint } from "../../emulator/components/XtermMountPoint.js";
import { LeaseLine } from "../../lease/components/LeaseLine.js";
import { useTakeShell } from "../../lease/hooks/useTakeShell.js";
import {
  canTypeIntoShell,
  projectTerminalLease,
  type TerminalLeaseState,
} from "../../lease/state.js";
import { useShellOutput } from "../hooks/useShellOutput.js";

/** The shell body's accessible name. */
const TERMINAL_OUTPUT_LABEL = "Shell output";

/** The shell to show, the bridge its streams ride, and the stores its lease is read from. */
export interface ShellBodyProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
  readonly shell: TerminalListEntry;
}

/** One shell's lease line, live emulator and refusal line. */
export function ShellBody(props: ShellBodyProps): React.JSX.Element {
  const { bridge, sessionId, sessionStore, frameStore, shell } = props;
  const { terminalId } = shell;
  const standingEvents = useSessionStore(sessionStore, selectStandingEvents);
  const thisDeviceId = useMainProcessState(frameStore).negotiation?.deviceId;
  const output = useShellOutput(bridge, { sessionId, terminalId });

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
  const { outputSubscriptionId } = output;

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
        isWriteEnabled={canTypeIntoShell(lease.holder) && outputSubscriptionId !== undefined}
        label={TERMINAL_OUTPUT_LABEL}
        onKeystroke={output.typeKeys}
        openOutput={output.openOutput}
      />
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
  return <LeaseLine state={lease} holderName={undefined} takeShell={takeShell} />;
}
