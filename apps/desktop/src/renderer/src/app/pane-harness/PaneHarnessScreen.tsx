// The one way a registered pane body is opened in a running window; fixture builds only.
//
// The endurance tier needs a window that holds one pane instance and everything it owns (the
// emulator, its WebGL renderer, the pane's React tree, lease and store state) without a pane
// layout around it, so no tab strip, drag target or layout chrome is folded into a
// per-instance figure. It resolves through `PaneRegistry.descriptorFor` and never imports a
// pane, so it mounts what the pane layout would. The kind travels on the address, so this
// module names no pane kind.
//
// Bodies mount as elements with stable keys, not as inline calls: the count of open bodies
// varies, and calling each body's hooks inline would change the hook count when the control
// is used. Stable keys also leave the first instance standing when a second opens. Two
// `#/pane-harness/...` addresses resolve to this one screen, so `AppRouter` keys the screen on
// the address and the count resets whenever the kind or session changes; the pane keys carry
// the session so instances are never handed to a session they were not bound to.

import { useState } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { PaneHarnessFrame } from "./PaneHarnessFrame.js";
import { paneHarnessInstances } from "./instances.js";
import { parsePaneAddress } from "#renderer/routing/panes/parse-address.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";

/** The harness screen's inputs: the route's context, its harness route, and the pane board. */
export interface PaneHarnessScreenProps {
  readonly context: ScreenContext;
  readonly route: Extract<AppRoute, { readonly kind: "pane-harness" }>;
  readonly paneRegistry: PaneRegistry;
}

/**
 * The harness: an addressed pane kind, and however many instances of it are open.
 *
 * Exported so its co-located test can drive it without a route, by handing it a context.
 */
export function PaneHarnessScreen(props: PaneHarnessScreenProps): React.JSX.Element {
  const { context, route, paneRegistry } = props;
  const [openInstanceCount, setOpenInstanceCount] = useState(0);

  // The app's one admission point for an untyped address, the same predicate a layout
  // snapshot read off disk is held to; a typed hash is that second boundary.
  const address = parsePaneAddress(route.paneKind, undefined);
  if ("code" in address) {
    return (
      <PaneHarnessFrame instanceCount={0} paneKindLabel={route.paneKind}>
        <Nothing
          kind="error"
          placement="block"
          title="That address does not name a pane this build can open."
          detail={address.detail}
        />
      </PaneHarnessFrame>
    );
  }

  const descriptor = paneRegistry.descriptorFor(address.kind);
  if (descriptor === undefined) {
    // No feature registered a body for this kind; say so rather than draw a placeholder.
    return (
      <PaneHarnessFrame instanceCount={0} paneKindLabel={address.kind}>
        <Nothing
          kind="empty"
          placement="block"
          title="No feature has registered a body for this pane kind."
          detail={
            `"${address.kind}" is one of the pane kinds and nothing in this ` +
            `build renders it, so there is no instance for a harness to hold.`
          }
        />
      </PaneHarnessFrame>
    );
  }

  const instances = paneHarnessInstances(
    descriptor,
    context,
    address,
    route.sessionId,
    openInstanceCount,
  );

  return (
    <PaneHarnessFrame
      instanceCount={openInstanceCount}
      paneKindLabel={address.kind}
      onOpen={() => {
        // Unbounded on purpose: the page's WebGL context ledger in
        // `features/terminal/emulator/renderer-pool.ts` already bounds it and degrades past it.
        setOpenInstanceCount((count) => count + 1);
      }}
      onClose={() => {
        setOpenInstanceCount((count) => Math.max(0, count - 1));
      }}
    >
      {instances.map(({ key, PaneBody, context: paneContext }) => (
        <PaneBody key={key} {...paneContext} />
      ))}
    </PaneHarnessFrame>
  );
}
