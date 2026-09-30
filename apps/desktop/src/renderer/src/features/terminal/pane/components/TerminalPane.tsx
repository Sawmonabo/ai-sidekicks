// The terminal pane's registered body: the session's shared shell inside the pane frame.
//
// Its one decision is whether a session was addressed; everything that needs a store is in
// `SessionTerminalPane.tsx`, because store hooks may only run when there is a store. The frame
// names the region, so this module sets no label and no tab stop.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { SessionTerminalPane } from "./SessionTerminalPane.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";

/** The registered terminal body: the bound pane, or a sentence that no session was addressed. */
export function TerminalPane(context: PaneContextOf<"terminal">): React.JSX.Element {
  // The shell is keyed by the session, so the pane's own id is not read.
  const { sessionStore } = context;
  return (
    <PaneFrame kind="terminal" sessionId={sessionStore?.sessionId}>
      <div className="meridian-terminal-pane">
        {sessionStore === undefined ? (
          <Nothing
            kind="not-checked"
            placement="block"
            title="This pane is not bound to a session."
            detail="A session's shared shell is reached through the session it belongs to, and this pane was opened without one. Nothing here says the session has no terminal — only that none was addressed."
          />
        ) : (
          <SessionTerminalPane sessionStore={sessionStore} />
        )}
      </div>
    </PaneFrame>
  );
}
