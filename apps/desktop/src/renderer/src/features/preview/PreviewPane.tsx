// The Preview pane the registry mounts for the `browser` kind. The tab strip, address field and
// page viewport are in `PreviewPaneContent.tsx`.

import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";

/** The Preview pane's frame with an empty body. */
export function PreviewPane(context: PaneContextOf<"browser">): React.JSX.Element {
  return (
    <PaneFrame kind="browser" sessionId={context.sessionStore?.sessionId}>
      <div className="meridian-preview-pane" />
    </PaneFrame>
  );
}
