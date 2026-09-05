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
// ONE DOOR, NOT A SECOND REGISTRY — AND THE DOOR THIS COMPOSITION FILLED. The pane
// body is resolved through the pane board on the surface context, which is the deck's
// own single mount door, so this surface renders the same body the deck will and
// cannot drift from it. A kind with no registered body is the registry's own
// reserved-not-stubbed absence rather than a hole.
//
// Off the context rather than the process-wide singleton, because `registerConsoleFamilies`
// takes the board as a parameter: a test and an auxiliary window compose their own, and
// a host that read the singleton showed such a composition the reserved absence — or a
// production body it had deliberately not registered — however carefully it had asked.
// That is inert only while every pane seat is still reserved, and this family fills two.
//
// THE SCOPE IS HELD HERE BECAUSE BOTH HALVES OF THE SLOT NEED IT. The destination
// asks which session it reads from, and the pane it opens has to be handed that same
// session's store: an address carries a definition or a run and never a session, so a
// host that resolved its own answer would hand a body the window's retained session
// while the person in front of it had explicitly chosen another. That is one fact, so
// it is one piece of state, held at the surface both halves hang off and pushed DOWN
// — the destination is controlled rather than reporting its settlement back up, which
// would be a second copy of a value `destination-scope.ts` already computes.

import { useCallback, useState } from "react";

import type { ConsolePaneAddress } from "../seats/index.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { useFrameStore } from "../store/index.js";
import { OpenPaneBody } from "./OpenPaneBody.js";
import {
  FOLLOWING_WINDOW_RETENTION,
  scopeSessionIdFor,
  type WorkflowsScopeState,
} from "./destination-scope.js";
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
  // Held for the mount and pushed down, never persisted — `WorkflowsDestination.tsx`'s
  // header says why the choice itself is not written anywhere durable. The setter React
  // gives back is stable, so the controlled destination is not handed a fresh callback
  // on every pass.
  const [scope, setScope] = useState<WorkflowsScopeState>(FOLLOWING_WINDOW_RETENTION);
  // Read through the store's own selector seam rather than off the surface context,
  // so a session opened while this surface is mounted is reflected here as it is in
  // the destination beside it.
  const retainedSessionId = useFrameStore(context.frameStore, (state) => state.lastOpenedSessionId);
  const scopeSessionId = scopeSessionIdFor(scope, retainedSessionId);

  if (openAddress === undefined) {
    return (
      <WorkflowsDestination
        growth={context.bridge.growth}
        frameStore={context.frameStore}
        sessionStoreRegistry={context.sessionStoreRegistry}
        scope={scope}
        onScopeChange={setScope}
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
      <OpenPaneBody address={openAddress} context={context} scopeSessionId={scopeSessionId} />
    </div>
  );
}
