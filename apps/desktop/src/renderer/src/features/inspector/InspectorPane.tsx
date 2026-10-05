// The inspector pane: one entity's own record, whichever kind of entity it is.
//
// The pane offers no control that acts on the entity it shows. Pausing a run, deciding an
// approval and deleting an artifact belong to the controls that own those verbs; a control
// here would be a second place eligibility is decided.

import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "#renderer/registries/panes/pane-body-for-kind.js";
import { InspectorPaneBody } from "./components/InspectorPaneBody.js";

/** The inspector pane body, framed as a pane and reading one entity from its session. */
export function InspectorPane(context: PaneContextOf<"inspector">): React.JSX.Element {
  return (
    <PaneFrame kind="inspector" sessionId={context.sessionStore?.sessionId} entity={context.entity}>
      <InspectorPaneBody context={context} />
    </PaneFrame>
  );
}
