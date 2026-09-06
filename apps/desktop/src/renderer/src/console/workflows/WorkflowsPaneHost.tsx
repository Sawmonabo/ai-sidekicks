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
//
// AND BOTH ARE HELD AGAINST THE PORT, BECAUSE BOTH ARE ANSWERS ABOUT ONE DAEMON. The
// chosen session and the open pane address are choices a person made from lists the
// bridge below served, and the fixture's scenario switch replaces that bridge without
// unmounting this host. Held for the MOUNT, a session picked under the previous port
// scoped both of the destination's reads under the next one and the open address named
// a run the next one has never heard of — so the browser asserted "no definitions in
// this session" and the pane asserted a run's absence, two claims about a daemon
// nothing had asked. The reads below were already addressed by the port; these two are
// the choices MADE from them, and a choice outliving the answer it was made from is
// the same conflation one level up. Both therefore re-mint during the render that
// brings the new port, exactly as `seats/session-directory.ts` re-reads in it.

import { useCallback } from "react";

import type { ConsolePaneAddress, ConsoleSurfaceContext } from "../seats/index.js";
import { useFrameStore, useSubjectScopedState } from "../store/index.js";
import { OpenPaneBody } from "./OpenPaneBody.js";
import {
  FOLLOWING_WINDOW_RETENTION,
  scopeSessionIdFor,
  WorkflowsDestination,
  type WorkflowsScopeState,
} from "./destination/index.js";

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
  // The board THIS composition registered its bodies into, off the surface context
  // rather than the process-wide singleton — the context carries it for exactly this
  // reason, and a host that reached for the singleton would warm production's board
  // from a window that had been handed its own.
  const { paneRegistry } = context;
  // Addressed by the port and by nothing else, which is the whole of what either choice
  // is about — there is no second key, because a person choosing a session and opening
  // a pane from it is answering one daemon.
  const { value: openAddress, publish: setOpenAddress } = useSubjectScopedState<
    ConsolePaneAddress | undefined
  >(context.bridge.growth, undefined, () => undefined);
  // Stable across every render that did not re-address, so the destination's memoized
  // children are not handed a fresh action each pass; the publisher the holder gives
  // back moves exactly when the port does, which is when they should be.
  const openPane = useCallback(
    (address: ConsolePaneAddress) => {
      // Warmed BEFORE the address is published, which is what makes this a preload
      // rather than a second load: publishing re-renders this host and mounts the pane,
      // and a loader-backed body reached at that mount would show its reserved frame
      // first. One statement earlier, the fetch is already in flight.
      //
      // Fire-and-forget: the mount is what waits for the body, and a speculative warm
      // that could not fetch its chunk has nobody to tell — the console's surface error
      // boundary reports that at the mount, where somebody is looking.
      void paneRegistry.preload(address.kind).catch(() => undefined);
      setOpenAddress(address);
    },
    [paneRegistry, setOpenAddress],
  );
  const closePane = useCallback(() => {
    setOpenAddress(undefined);
  }, [setOpenAddress]);
  // Pushed down and never persisted — `WorkflowsDestination.tsx`'s header says why the
  // choice itself is not written anywhere durable.
  const { value: scope, publish: setScope } = useSubjectScopedState<WorkflowsScopeState>(
    context.bridge.growth,
    undefined,
    () => FOLLOWING_WINDOW_RETENTION,
  );
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
