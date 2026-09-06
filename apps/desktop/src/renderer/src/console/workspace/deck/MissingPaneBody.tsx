// A pane kind the deck holds and no family has a body for.
//
// Its own module for the one-component rule.

import { Nothing } from "../../primitives/index.js";
import { type PaneKind } from "../../seats/index.js";

/**
 * A pane kind the deck holds and no family has a body for.
 *
 * Reserved, not stubbed: the kind set is closed by the spec and two of its members
 * are gated on their own amendments, so a deck restored from a snapshot can legally
 * name a kind this build has not mounted. Naming the kind beats an empty rectangle
 * that reads as a body which failed to render.
 */
export function MissingPaneBody(props: { readonly kind: PaneKind }): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="This kind of pane has not been built yet."
      detail={`Nothing renders a ${props.kind} pane in this build. The pane is reserved for it.`}
    />
  );
}
