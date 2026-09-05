// The registered body for one opened workflows address, and the store it is handed.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `WorkflowsPaneHost.tsx`, which is the
// package's one-component-per-`.tsx` rule: a module holding two components is a
// module whose name answers for one of them, and the second is reached only by
// reading the file. `primitives/ReadingNotice.tsx` is the precedent — a deep relative
// import from its host, and no door line, because nothing outside this family
// composes it.
//
// THE SCOPE RESOLUTION TRAVELS WITH THE BODY. `scopedSessionStore` has exactly one
// caller and it is the component below; splitting the two apart would leave a
// resolution rule in one module and the only decision it governs in another.

import type { ConsolePaneAddress, ConsolePaneContext } from "../seats/index.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { Nothing } from "../primitives/index.js";
import type { SessionStore } from "../store/index.js";

/**
 * The registered body for one address, or the registry's own absence.
 *
 * The store is the SCOPE's — the session the person in front of this surface settled
 * on, which outranks both the route and the window's retention because it is the one
 * of the three they performed deliberately. A pane handed no store renders its own
 * absence, which is the honest shape wherever no session is in scope at all.
 *
 * The BOARD is the composition's, taken off the same context: this surface resolves
 * bodies from the registry the composition around it registered them into, never from
 * the process-wide one.
 */
export function OpenPaneBody(props: {
  readonly address: ConsolePaneAddress;
  readonly context: ConsoleSurfaceContext;
  readonly scopeSessionId: string | undefined;
}): React.JSX.Element {
  const { address, context, scopeSessionId } = props;
  const descriptor = context.paneRegistry.descriptorFor(address.kind);
  if (descriptor === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="That pane has not been built yet."
        detail={`Nothing is registered for the "${address.kind}" pane. It is reserved, not missing.`}
      />
    );
  }
  // Through the address's own discriminant: `ConsolePaneAddress` is a kind-scoped
  // union, so a session-scoped arm carries no entity to name a pane after and a bare
  // arm carries none yet.
  const addressedEntityId = "entity" in address ? address.entity?.id : undefined;
  const paneContext: ConsolePaneContext = {
    ...address,
    // Deterministic in the address rather than minted, so re-opening the same subject
    // is the same pane and React keeps whatever state its body holds.
    paneId: `workflows:${address.kind}:${addressedEntityId ?? "new"}`,
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: scopedSessionStore(context, scopeSessionId),
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    // Nothing linked this pane to another: this surface opens one pane at a time from
    // its own lists, not from a pane beside it. A required member carrying `undefined`
    // rather than an omitted one, which is the binding's own rule — an absent key
    // reads identically whether the host decided there was no source pane or forgot.
    linkedSourcePaneId: undefined,
    // No actor to attribute this pane to on a bare route, which is the fail-closed
    // answer: an unattributed pane takes the neutral boundary and not someone's hue.
    focusHue: undefined,
  };
  return <>{descriptor.render(paneContext)}</>;
}

/**
 * The store for the session in scope, and never another session's.
 *
 * `peek`, never `open`: opening a session is a lifecycle act, and a surface that
 * performed one to render a pane would create state nobody asked for. The route's
 * store serves only where it is the SAME session — it is the one this window is
 * actually in, so where the scope names it there is no reason to prefer a registry
 * entry — and where the scope names a session this window has not opened, the answer
 * is nothing rather than the route's, because handing a body a different session's
 * store is the defect this resolution exists to end.
 *
 * With nothing in scope at all the route's store is all there is, which is the arm
 * that matters the day this host is mounted somewhere that names a session.
 */
function scopedSessionStore(
  context: ConsoleSurfaceContext,
  scopeSessionId: string | undefined,
): SessionStore | undefined {
  if (scopeSessionId === undefined) {
    return context.sessionStore;
  }
  return (
    context.sessionStoreRegistry.peek(scopeSessionId) ??
    (context.sessionStore?.sessionId === scopeSessionId ? context.sessionStore : undefined)
  );
}
