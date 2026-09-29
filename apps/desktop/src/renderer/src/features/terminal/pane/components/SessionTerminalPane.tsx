// The terminal pane once a session is addressed.
//
// Split from `TerminalPane.tsx` because the store hook below may only be called when
// there IS a store; the split makes that condition a mount rather than a branch.
//
// A session has one shared terminal, so the session id is the terminal's identity. The
// lease line states the holder from the session's log and draws no claim control, and
// the emulator mounts with nothing to show.

import { useMemo } from "react";

import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";
import { LeaseLine } from "../../lease/components/LeaseLine.js";
import { XtermHost } from "../../emulator/components/XtermHost.js";
import { projectTerminalLease, type TerminalLeaseState } from "../../lease/lease-model.js";

/** What this family calls the surface, and the base the name below is built on. */
const TERMINAL_PANE_WORD = "Terminal";

/**
 * The emulator's accessible name, inside the pane.
 *
 * `seats/ConsolePaneChrome` names the pane's own region, from a title table that is
 * module-private to it — deliberately, so the view families cannot each spell the same
 * pane two ways — and the emulator INSIDE it is still this family's to name. Deriving
 * from a local word rather than reaching for that table is what keeps the private table
 * private; the cost is that a rename of the pane kind does not reach in here, which is
 * why the word above is stated as the base of a derivation rather than as the pane's
 * name.
 */
const TERMINAL_OUTPUT_LABEL = `${TERMINAL_PANE_WORD} output`;

/** The store of the session whose shell the pane shows. */
export interface SessionTerminalPaneProps {
  readonly sessionStore: SessionStore;
}

/** The lease line over the emulator, for one addressed session. */
export function SessionTerminalPane(props: SessionTerminalPaneProps): React.JSX.Element {
  const { sessionStore } = props;
  const sessionId = sessionStore.sessionId;
  const timeline = useSessionStore(sessionStore, selectTimeline);

  // Derivation under `useMemo`: the selector returns the stored array and the fold runs
  // only when that array's identity changes.
  const lease: TerminalLeaseState = useMemo(
    () => projectTerminalLease(timeline, { thisDeviceId: undefined }),
    [timeline],
  );

  return (
    <>
      <LeaseLine state={lease} />
      <XtermHost
        terminalId={sessionId}
        isWriteEnabled={lease.holding === "held-by-this-device"}
        label={TERMINAL_OUTPUT_LABEL}
      />
    </>
  );
}

/** Stored reference, never a built value — the store's own equality rests on it. */
function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}
