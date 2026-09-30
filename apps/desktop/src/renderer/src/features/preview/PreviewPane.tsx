// The pane layout's browser pane: the body the registry mounts for the `browser` kind.
//
// It draws the pane layout's frame and an empty body. The tab strip, the address field and the
// page viewport are `PreviewPaneContent.tsx`, which takes the page readings, the page acts
// and a view host as arguments.

import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";

/** The browser pane's frame with an empty body. */
export function PreviewPane(context: PaneContextOf<"browser">): React.JSX.Element {
  return (
    <PaneFrame kind="browser" sessionId={context.sessionStore?.sessionId}>
      <div className="meridian-preview-pane" />
    </PaneFrame>
  );
}
