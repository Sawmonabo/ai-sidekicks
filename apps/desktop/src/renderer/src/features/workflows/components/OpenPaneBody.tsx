// The registered body for one opened workflows address, and the store it is handed.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `WorkflowsScreen.tsx`, which is the
// package's one-component-per-`.tsx` rule: a module holding two components is a
// module whose name answers for one of them, and the second is reached only by
// reading the file. The screen imports it by relative path and the feature's `index.ts`
// does not export it, because nothing outside the workflows feature composes it.

import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { PaneContext } from "@renderer/registries/panes/pane-context.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";

/**
 * The registered body for one address, or nothing when the kind has none.
 *
 * The pane is handed the screen context's own stores. Its body resolves from the pane
 * registry on that context, the one the Workflows screen's composition registered into,
 * never from the process-wide one.
 */
export function OpenPaneBody(props: {
  readonly address: PaneAddress;
  readonly context: ScreenContext;
}): React.JSX.Element {
  const { address, context } = props;
  const descriptor = context.paneRegistry.descriptorFor(address.kind);
  if (descriptor === undefined) {
    return <></>;
  }
  // Through the address's own discriminant: `PaneAddress` is a kind-scoped
  // union, so a session-scoped arm carries no entity to name a pane after and a bare
  // arm carries none yet.
  const addressedEntityId = "entity" in address ? address.entity?.id : undefined;
  const paneContext: PaneContext = {
    ...address,
    // Deterministic in the address rather than minted, so re-opening the same subject
    // is the same pane and React keeps whatever state its body holds.
    paneId: `workflows:${address.kind}:${addressedEntityId ?? "new"}`,
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    // Nothing linked this pane to another: the Workflows screen opens one pane at a time
    // from its own lists, not from a pane beside it. A required member carrying `undefined`
    // rather than an omitted one, which is the binding's own rule — an absent key
    // reads identically whether the host decided there was no source pane or forgot.
    linkedSourcePaneId: undefined,
    // No actor to attribute this pane to on a bare route, which is the fail-closed
    // answer: an unattributed pane takes the neutral boundary and not someone's hue.
  };
  return <>{descriptor.render(paneContext)}</>;
}
