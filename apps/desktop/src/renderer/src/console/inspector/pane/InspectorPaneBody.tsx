// The inspector's two boundary arms, split from the frame that wears them.
//
// Its own module because a `.tsx` declares one component, and the split is load-
// bearing rather than clerical: the record's hooks live below this branch, so a body
// that ran inside the frame would call them conditionally. `ApprovalsPaneBody.tsx`
// and `RunsPaneBody.tsx` are the same shape one directory over.

import { Nothing } from "../../primitives/index.js";
import { type PaneContextOf } from "../../panes/pane-chrome.js";
import { InspectedEntity } from "./entity-detail/InspectedEntity.js";

/**
 * The two boundary arms, split from the frame so the record's hooks are never
 * called conditionally.
 *
 * `linkedSourcePaneId` comes straight off the pane context, which is where the deck
 * puts it: a pane opened from another carries the source pane's id on its seat, and
 * an unlinked one carries `undefined` there deliberately rather than by omission. So
 * the record claims a link exactly when the deck made one, and the pane invents
 * neither the presence nor the absence.
 */
export function InspectorPaneBody(props: {
  readonly context: PaneContextOf<"inspector">;
}): React.JSX.Element {
  const { context } = props;
  // There is no arm for a missing entity, and that is the seat's doing rather than an
  // omission: `seats/pane-address.ts` makes the inspector's address REQUIRE one, so an
  // address with none is refused as `pane-entity-required` at the two untyped
  // boundaries — a restored layout row and a typed route — and never reaches a body.
  if (context.sessionStore === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This pane was opened outside a session."
        detail="Every entity the inspector reads belongs to a session, and a bare route holds none. Open the session this entity belongs to and its record appears."
      />
    );
  }
  return (
    <InspectedEntity
      entityRef={context.entity}
      sessionStore={context.sessionStore}
      linkedSourcePaneId={context.linkedSourcePaneId}
    />
  );
}
