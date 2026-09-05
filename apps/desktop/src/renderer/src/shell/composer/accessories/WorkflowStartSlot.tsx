// The plus menu's workflow entry: a seat another plan fills.
//
// Split from `PlusMenu.tsx` because the menu owns its own items and this owns a
// hole in it. The distinction is load-bearing: the menu's items are this console's
// to change, and what renders here is not — the owning plan mounts a body through
// the seat, and until it does the slot renders the seat's own absence copy rather
// than a stand-in that would read as the feature.

import { Nothing } from "../../../console/primitives/index.js";
import type { OwnerSlotProps } from "../../../console/seats/index.js";

/** One plan-owned seat, rendered the composer's own way. */
export function WorkflowStartSlot(props: OwnerSlotProps<React.ReactNode>): React.JSX.Element {
  if (props.body !== undefined) {
    return <div className="meridian-plus-menu__workflow">{props.body}</div>;
  }
  return (
    <div className="meridian-plus-menu__workflow">
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Starting a workflow has not been built here yet."
        detail="The picker lists the definitions this session can start, so it arrives with the enumeration it lists from."
      />
    </div>
  );
}
