// The browser pane's body — the fixture shell the chrome is built into.
//
// SHELL, WITH A DELETION OBLIGATION. `Plan-023 §Console growth slate` rows 1, 2,
// and 4 (the browser bridge namespace, the daemon-to-desktop tool relay, and the
// dev-server probe) are unregistered, and the pane's own registration is gated on
// the embedded-browser Type-2 ADR besides. So there is no page list, no navigation
// state, and no history depth to render, and this body renders that fact instead of
// a chrome whose every control would dispatch into a refusal. The tab strip, the
// address field, the six visible controls, and the overflow of
// `Spec-023 §Console Design (Meridian)` 12.2 land on top of this shell in the same
// task once those rows leave the slate; this absence is deleted then, not kept
// beside them.
//
// WHY `not-checked` AND NOT `empty`. The console has not asked. Rendering "no pages
// open" would assert a fact about this session that no read established, which is
// exactly the conflation rule 8 forbids — and it would be the wrong one to make,
// because an agent that opened three background pages produces the identical empty
// screen. The dotted boundary says nobody asked, and that is true on both bridges:
// the growth port refuses under the live bridge, and the fixture serves no browser
// operation either.
//
// The pane takes no context. Every field on `ConsolePaneContext` names something
// this shell has no read for — the addressed page, the session's stores, the focus
// hue the chrome's own frame will wear — and a parameter destructured to satisfy a
// convention is a claim that the body uses it.

import { Nothing } from "../../primitives/index.js";

/** The pane region's accessible name. The tab strip's own labels arrive with it. */
const BROWSER_PANE_LABEL = "Browser";

export function BrowserPane(): React.JSX.Element {
  return (
    <section aria-label={BROWSER_PANE_LABEL}>
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This session's pages have not been read."
        detail="The browser pane's bridge namespace is not registered yet, so the console has not asked which pages this session owns. Nothing here says there are none — only that no question was put."
      />
    </section>
  );
}
