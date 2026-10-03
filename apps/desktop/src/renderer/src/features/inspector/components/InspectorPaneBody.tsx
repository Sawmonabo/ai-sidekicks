// The inspector's boundary arm, split from the frame that wears it: the record's hooks live
// below this branch, so a body running inside the frame would call them conditionally.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { InspectedEntity } from "../entity-detail/components/InspectedEntity.js";

/**
 * The pane with no session, or the record for the addressed entity.
 *
 * `linkedSourcePaneId` comes straight off the pane context: the record claims a link exactly
 * when the pane layout made one.
 */
export function InspectorPaneBody(props: {
  readonly context: PaneContextOf<"inspector">;
}): React.JSX.Element {
  const { context } = props;
  // No arm for a missing entity: `parsePaneAddress` refuses an inspector address without one,
  // so a body is never reached without it.
  if (context.sessionStore === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="block"
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
