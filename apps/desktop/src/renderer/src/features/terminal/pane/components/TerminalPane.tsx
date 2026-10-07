// The terminal pane's registered body: the session's shared shell inside the pane frame.
//
// Its one decision is whether a session was addressed, and with none it draws nothing inside the
// frame; everything that needs a store is in `SessionTerminalPane.tsx`, because store hooks may
// only run when there is a store. The frame names the region, so this module sets no label and
// no tab stop.

import "./TerminalPane.css";

import { SessionTerminalPane } from "./SessionTerminalPane.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "#renderer/registries/panes/body-for-kind.js";

/** The registered terminal body: the bound pane, or an empty body when no session was addressed. */
export function TerminalPane(context: PaneContextOf<"terminal">): React.JSX.Element {
  // The shell is keyed by the session, so the pane's own id is not read.
  const { sessionStore, frameStore } = context;
  return (
    <PaneFrame kind="terminal" sessionId={sessionStore?.sessionId}>
      <div className="meridian-terminal-pane">
        {sessionStore === undefined ? null : (
          <SessionTerminalPane sessionStore={sessionStore} frameStore={frameStore} />
        )}
      </div>
    </PaneFrame>
  );
}
