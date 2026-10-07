// The terminal pane once a session is addressed: the emulator under the shell's lease.
//
// Split from `TerminalPane.tsx` because the store hooks may only be called when there is a
// store. The pane shows the shell keyed by the session's id, and its write gate opens on the
// lease folded from the session log against this device's id, which main's connection to the
// service was given; until that id is known another device's hold, or this device's own, reads as
// not yet read and the body stays read-only.

import { useMemo } from "react";

import type { TerminalId } from "@ai-sidekicks/contracts/pty";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { useMainProcessState } from "#renderer/store/window/hooks/useMainProcessState.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { XtermMountPoint } from "../../emulator/components/XtermMountPoint.js";
import {
  canTypeIntoShell,
  projectTerminalLease,
  type TerminalLeaseState,
} from "../../lease/state.js";

/** The shell body's accessible name. */
const TERMINAL_OUTPUT_LABEL = "Shell output";

/** The store of the session whose shell the pane shows, and the window's, for this device's id. */
export interface SessionTerminalPaneProps {
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
}

/** The emulator under the shell's lease, for one addressed session. */
export function SessionTerminalPane(props: SessionTerminalPaneProps): React.JSX.Element {
  const { sessionStore, frameStore } = props;
  const sessionId = sessionStore.sessionId;
  const transcript = useSessionStore(sessionStore, selectTranscript);
  const thisDeviceId = useMainProcessState(frameStore).negotiation?.deviceId;

  // The selector returns the stored array, so the fold reruns only when its identity changes.
  const lease: TerminalLeaseState = useMemo(
    () => projectTerminalLease(transcript, { terminalId: sessionId as TerminalId, thisDeviceId }),
    [sessionId, thisDeviceId, transcript],
  );

  return (
    <XtermMountPoint
      terminalId={sessionId}
      isWriteEnabled={canTypeIntoShell(lease.holder)}
      label={TERMINAL_OUTPUT_LABEL}
    />
  );
}
