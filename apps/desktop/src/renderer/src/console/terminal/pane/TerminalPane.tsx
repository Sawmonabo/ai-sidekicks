// The terminal pane: the session's one shared shell, its lease, and the emulator
// that shows it.
//
// This module is the pane's BOUNDARY — the registered body the deck mounts, and the
// one decision it makes: whether a session was addressed at all. Everything that
// needs a session is `BoundTerminalPane.tsx` beside it, because the store hooks it
// calls may only run when there IS a store and a hook behind a condition is the one
// React rule a surface cannot bend.
//
// THE FRAME AROUND IT IS `seats/ConsolePaneChrome`, which draws the section, the kind
// glyph, the address trail, the control strip, and the body box for every pane kind in
// the console. So this module names no region and sets no tab stop: the pane is named
// by its whole trail — the session it holds the shell of, then "Terminal" — and the
// emulator's own name inside it is the one accessible name this family still spells.
//
// The lease is wire-true: `pty.control_changed` carries the holder, the holder it replaced
// and a closed reason, so the holding line comes from the session log through
// `lease-model.ts`. The output stream is not built, so the emulator mounts with nothing
// to show.

import { Nothing } from "../../primitives/index.js";
import { BoundTerminalPane } from "./BoundTerminalPane.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";

/** The registered terminal body: the bound pane, or a sentence that no session was addressed. */
export function TerminalPane(context: PaneContextOf<"terminal">): React.JSX.Element {
  // The shell this pane shows is keyed by the SESSION, so the pane's own id is not read.
  const { sessionStore, focusHue } = context;
  return (
    <ConsolePaneChrome kind="terminal" sessionId={sessionStore?.sessionId} focusHue={focusHue}>
      <div className="meridian-terminal-pane">
        {sessionStore === undefined ? (
          <Nothing
            kind="not-checked"
            placement="surface"
            title="This pane is not bound to a session."
            detail="A session's shared shell is reached through the session it belongs to, and this pane was opened without one. Nothing here says the session has no terminal — only that none was addressed."
          />
        ) : (
          <BoundTerminalPane sessionStore={sessionStore} />
        )}
      </div>
    </ConsolePaneChrome>
  );
}
