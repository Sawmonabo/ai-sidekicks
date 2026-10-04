// The terminal pane once a session is addressed: the lease line over the emulator.
//
// Split from `TerminalPane.tsx` because the store hook may only be called when there is a
// store. The pane shows the shell keyed by the session's id; the lease line states its holder
// from the session log, and the emulator mounts with nothing to show.

import { useMemo } from "react";

import type { TerminalId } from "@ai-sidekicks/contracts/pty";

import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { selectTranscript } from "@renderer/store/session/session-selectors.js";
import { LeaseLine } from "../../lease/components/LeaseLine.js";
import { XtermMountPoint } from "../../emulator/components/XtermMountPoint.js";
import { projectTerminalLease, type TerminalLeaseState } from "../../lease/lease-model.js";

/** The shell body's accessible name. */
const TERMINAL_OUTPUT_LABEL = "Shell output";

/** The store of the session whose shell the pane shows. */
export interface SessionTerminalPaneProps {
  readonly sessionStore: SessionStore;
}

/** The lease line over the emulator, for one addressed session. */
export function SessionTerminalPane(props: SessionTerminalPaneProps): React.JSX.Element {
  const { sessionStore } = props;
  const sessionId = sessionStore.sessionId;
  const transcript = useSessionStore(sessionStore, selectTranscript);

  // The selector returns the stored array, so the fold reruns only when its identity changes.
  const lease: TerminalLeaseState = useMemo(
    () =>
      projectTerminalLease(transcript, {
        terminalId: sessionId as TerminalId,
        thisDeviceId: undefined,
      }),
    [sessionId, transcript],
  );

  return (
    <>
      <LeaseLine state={lease} />
      <XtermMountPoint
        terminalId={sessionId}
        isWriteEnabled={lease.holder === "held-by-this-device"}
        label={TERMINAL_OUTPUT_LABEL}
      />
    </>
  );
}
