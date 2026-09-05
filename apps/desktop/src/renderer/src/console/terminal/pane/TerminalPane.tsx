// The terminal pane: the session's one shared shell, its lease, and the emulator
// that shows it.
//
// This module is the pane's BOUNDARY — the registered body the deck mounts, and the
// one decision it makes: whether a session was addressed at all. Everything that
// needs a session is `BoundTerminalPane.tsx` beside it, because the store hooks it
// calls may only run when there IS a store and a hook behind a condition is the one
// React rule a surface cannot bend.
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
import { TERMINAL_PANE_LABEL } from "./terminal-pane-labels.js";
import type { ConsolePaneContext } from "../../seats/index.js";

/**
 * What the pane reads off the deck's context, and nothing more.
 *
 * A `Pick` rather than the whole `ConsolePaneContext`, on `BrowserPane`'s rule
 * that a parameter destructured to satisfy a convention is a claim that the body
 * uses it. The registry's `render` still accepts this component, because a context
 * satisfies the narrower shape.
 */
export type TerminalPaneProps = Pick<ConsolePaneContext, "paneId" | "bridge" | "sessionStore">;

export function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore } = props;
  return (
    <section className="meridian-terminal-pane" aria-label={TERMINAL_PANE_LABEL}>
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
    </section>
  );
}
