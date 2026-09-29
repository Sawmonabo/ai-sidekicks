// The deck's browser pane: the body the registry mounts for the `browser` kind.
//
// It draws the deck's frame and an empty body. The tab strip, the address field and the
// page viewport are `PreviewPaneContent.tsx`, which takes the page readings, the page acts
// and a view host as arguments.

import { PaneFrame, type PaneContextOf } from "@renderer/console/seats/index.js";

/** The browser pane's frame with an empty body. */
export function PreviewPane(context: PaneContextOf<"browser">): React.JSX.Element {
  return (
    <PaneFrame
      kind="browser"
      sessionId={context.sessionStore?.sessionId}
      focusHue={context.focusHue}
    >
      <div className="meridian-preview-pane" />
    </PaneFrame>
  );
}
