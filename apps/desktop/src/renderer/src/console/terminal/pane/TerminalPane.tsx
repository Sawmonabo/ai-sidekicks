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
// WHAT IS LIVE HERE AND WHAT IS NOT. The lease is wire-true today —
// `pty.control_changed` is a registered event type carrying the holder, the holder
// it replaced, and a closed five-member reason — so the holder line, the transition
// ledger, and every state 8.8 names are folded from the session log by
// `lease-model.ts` and are not fixtures. The OUTPUT is not: the byte stream, the
// scrollback, and the resize report are `Plan-023 §Console growth slate` row 3,
// which the growth port refuses by name. `terminal/pane/output-stream.ts` holds that read
// and the deletion obligation that retires it.

import { Nothing } from "../../primitives/index.js";
import { BoundTerminalPane } from "./BoundTerminalPane.js";
import { ConsolePaneChrome, type ConsolePaneContext } from "../../seats/index.js";

/**
 * What the pane reads off the deck's context, and nothing more.
 *
 * A `Pick` rather than the whole `ConsolePaneContext`, on `BrowserPane`'s rule
 * that a parameter destructured to satisfy a convention is a claim that the body
 * uses it. The registry's `render` still accepts this component, because a context
 * satisfies the narrower shape.
 */
export type TerminalPaneProps = Pick<
  ConsolePaneContext,
  "paneId" | "bridge" | "sessionStore" | "focusHue"
>;

export function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore } = props;
  return (
    <ConsolePaneChrome
      kind="terminal"
      sessionId={sessionStore?.sessionId}
      focusHue={props.focusHue}
    >
      <div className="meridian-terminal-pane">
        {sessionStore === undefined ? (
          <Nothing
            kind="not-checked"
            placement="surface"
            title="This pane is not bound to a session."
            detail="A session's shared shell is reached through the session it belongs to, and this pane was opened without one. Nothing here says the session has no terminal — only that none was addressed."
          />
        ) : (
          <BoundTerminalPane bridge={bridge} sessionStore={sessionStore} />
        )}
      </div>
    </ConsolePaneChrome>
  );
}
