// What the rail's workflows slot mounts: the destination, and whichever pane a person
// opened from it.
//
// WHY THE SLOT NEEDS MORE THAN THE DESTINATION. `Spec-023 §Console Design (Meridian)`
// says it in one clause — "the workflows rail destination opens `workflow-builder`" —
// and until this module nothing carried that out. The destination supplied no open
// action to the definitions browser and none to the run list, so every definition name
// and every run name rendered as a plain span; the two pane kinds this family claims
// were registered and reachable from their own tests and from nowhere else. An
// operator could see a parked run and could not get to the controls that lift it.
//
// WHERE AN OPENED PANE GOES. Into this surface, one at a time, in place of the lists
// it was opened from. That is NOT the session workspace's deck and does not grow into
// one: no layout, no second pane beside the first, no tear-off. `#/workflows` is a
// bare route — it names no session, so there is no workspace and no deck on it — and a
// destination that opened a pane into a deck that is not on screen would be a control
// that does nothing, which is the state this module exists to end. When the deck ships
// the change here is one line: this host hands its address to the deck's own opener
// instead of holding it, and the pane-kind door below is already the one the deck uses.
//
// ONE DOOR, NOT A SECOND REGISTRY. The pane body is resolved through
// `consolePaneRegistry`, the deck's own single mount door, so this surface renders the
// same body the deck will and cannot drift from it. A kind with no registered body is
// the registry's own reserved-not-stubbed absence rather than a hole.

import { useCallback, useState } from "react";

import type { ConsolePaneAddress, ConsolePaneContext } from "../workspace/index.js";
import { consolePaneRegistry } from "../workspace/index.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { Nothing } from "../primitives/index.js";
import { useFrameStore } from "../store/index.js";
import { WorkflowsDestination } from "./WorkflowsDestination.js";

export interface WorkflowsPaneHostProps {
  /**
   * The whole surface context, because a pane context is composed from it.
   *
   * The destination alone needs three members and this host needs the rest: a pane
   * body is handed a bridge, both stores, the window store and its own address, and
   * composing that from three inputs would mean the seat passing six.
   */
  readonly context: ConsoleSurfaceContext;
}

/** The workflows slot: its destination, or the pane that destination opened. */
export function WorkflowsPaneHost(props: WorkflowsPaneHostProps): React.JSX.Element {
  const { context } = props;
  const [openAddress, setOpenAddress] = useState<ConsolePaneAddress | undefined>(undefined);
  // Stable across renders so the destination's memoized children are not handed a
  // fresh action every pass; the setter React gives back is itself stable.
  const openPane = useCallback((address: ConsolePaneAddress) => {
    setOpenAddress(address);
  }, []);
  const closePane = useCallback(() => {
    setOpenAddress(undefined);
  }, []);
  // Read through the store's own selector seam rather than off the surface context,
  // so a session opened while this surface is mounted is reflected here as it is in
  // the destination beside it.
  const retainedSessionId = useFrameStore(context.frameStore, (state) => state.lastOpenedSessionId);

  if (openAddress === undefined) {
    return (
      <WorkflowsDestination
        growth={context.bridge.growth}
        frameStore={context.frameStore}
        sessionStoreRegistry={context.sessionStoreRegistry}
        openPane={openPane}
      />
    );
  }
  return (
    <div className="meridian-workflows-pane-host">
      <button
        type="button"
        className="meridian-workflow__action meridian-workflows-pane-host__back"
        onClick={closePane}
      >
        Back to workflows
      </button>
      <OpenPaneBody address={openAddress} context={context} retainedSessionId={retainedSessionId} />
    </div>
  );
}

/**
 * The registered body for one address, or the registry's own absence.
 *
 * The session store is the route's where the route names one and the window's
 * retained session otherwise — `peek`, never `open`, because opening a session is a
 * lifecycle act and a surface that performed one to render a pane would create state
 * nobody asked for. A pane handed no store renders its own absence, which is the
 * honest shape on a bare route that names no session.
 */
function OpenPaneBody(props: {
  readonly address: ConsolePaneAddress;
  readonly context: ConsoleSurfaceContext;
  readonly retainedSessionId: string | undefined;
}): React.JSX.Element {
  const { address, context, retainedSessionId } = props;
  const descriptor = consolePaneRegistry.descriptorFor(address.kind);
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
  const sessionStore =
    context.sessionStore ??
    (retainedSessionId === undefined
      ? undefined
      : context.sessionStoreRegistry.peek(retainedSessionId));
  const paneContext: ConsolePaneContext = {
    ...address,
    // Deterministic in the address rather than minted, so re-opening the same subject
    // is the same pane and React keeps whatever state its body holds.
    paneId: `workflows:${address.kind}:${address.entity?.id ?? "new"}`,
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    // No actor to attribute this pane to on a bare route, which is the fail-closed
    // answer: an unattributed pane takes the neutral boundary and not someone's hue.
    focusHue: undefined,
  };
  return <>{descriptor.render(paneContext)}</>;
}
