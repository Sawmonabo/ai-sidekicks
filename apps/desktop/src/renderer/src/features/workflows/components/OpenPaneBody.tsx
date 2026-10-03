// The registered body for one opened workflows address, and the stores it is handed.
// A sibling of `WorkflowsScreen.tsx` because a `.tsx` file holds one component; the feature's
// `index.ts` does not export it since nothing outside the feature composes it.

import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { PaneContext } from "@renderer/registries/panes/pane-context.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";

/**
 * The registered body for one address, or nothing when the kind has none. The body resolves from
 * the pane registry on the screen context, never the process-wide one.
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
  // Through the address's own discriminant: a session-scoped arm carries no entity to name a
  // pane after, and a bare arm carries none yet.
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
    // Nothing linked this pane to another: the screen opens one pane at a time from its own
    // lists. `undefined` is explicit because a required member reads the same whether the host
    // decided there was no source pane or forgot.
    linkedSourcePaneId: undefined,
    // No actor to attribute this pane to on a bare route: an unattributed pane takes the neutral
    // boundary, not someone's hue.
  };
  return <>{descriptor.render(paneContext)}</>;
}
