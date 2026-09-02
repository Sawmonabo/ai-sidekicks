// The inspector pane's frame, and the place its reads will land.
//
// The inspector shows one entity's own record beside the events that touched it.
// It is addressed by `ConsolePaneAddress.entity`, and a deck may open it with no
// entity at all — which is why the breadcrumb comes from the shared scope helper
// rather than from a field this pane would have to guess at.
//
// `not-checked`, for the reason `RunsPane` gives: nothing is in flight, so a
// skeleton would claim a read is on its way and there is none.

import { Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "../pane-chrome.js";

export function InspectorPane(context: ConsolePaneContext): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="inspector"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
      focusHue={context.focusHue}
    >
      <Nothing
        kind="not-checked"
        placement="surface"
        title={
          context.entity === undefined
            ? "The inspector was opened without an entity to inspect."
            : "The console has not read this entity's record."
        }
        detail="An entity's own fields, the events that touched it, and the panes it can be opened into are read together and land here. The pane holds their place and asks nothing until it can answer."
      />
    </ConsolePaneChrome>
  );
}
