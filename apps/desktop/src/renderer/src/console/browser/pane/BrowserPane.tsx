// The deck's browser pane: the body the registry mounts for the `browser` kind.
//
// It draws the deck's frame and an empty body. The tab strip, the address field and the
// page viewport are `BrowserPaneChrome.tsx`, which takes the page readings, the page acts
// and a view host as arguments.

import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";

/** The browser pane's frame with an empty body. */
export function BrowserPane(context: PaneContextOf<"browser">): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="browser"
      sessionId={context.sessionStore?.sessionId}
      focusHue={context.focusHue}
    >
      <div className="meridian-browser-pane" />
    </ConsolePaneChrome>
  );
}
