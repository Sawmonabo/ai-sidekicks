// The inspector pane: one entity's own record, whichever kind of entity it is.
//
// The pane is addressed by `ConsolePaneAddress.entity`, and a deck may open it with
// no entity at all, so the frame answers two boundary questions before any read
// happens and the body answers the rest.
//
// TWO ABSENCES THAT ARE NOT THE SAME SENTENCE, and neither is "empty".
//
//   • **Opened with no entity.** The deck addressed an inspector at nothing. There
//     is no read to make and no record to wait for.
//   • **Opened outside a session.** There is an entity to inspect and no store to
//     read it from — a bare route holds none.
//
// Both are `not-checked`: nothing was asked. The arms below that — a read in
// flight, a projection the daemon says is incomplete, an answered read holding no
// such record — are the record's own, and `EntityRecord` ranks them.
//
// WHAT THIS PANE NEVER DOES. It offers no control that acts on the entity it shows.
// Pausing a run, deciding an approval, and deleting an artifact are the surfaces
// that own those verbs, gated on what the daemon declares; a control offered here
// would be a second place eligibility is decided, which is exactly the renderer-held
// truth `Spec-023 §Pitfalls To Avoid` names.

import { ConsolePaneChrome, paneScopeCrumbs, type PaneContextOf } from "../pane-chrome.js";
import { InspectorPaneBody } from "./InspectorPaneBody.js";

export function InspectorPane(context: PaneContextOf<"inspector">): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="inspector"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
      focusHue={context.focusHue}
    >
      <InspectorPaneBody context={context} />
    </ConsolePaneChrome>
  );
}
