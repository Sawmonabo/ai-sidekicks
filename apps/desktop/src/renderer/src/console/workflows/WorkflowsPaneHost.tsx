// What the rail's workflows slot mounts: the destination, and whichever pane a person opened
// from it.
//
// An opened pane goes into this surface, one at a time, in place of the destination it was
// opened from. That is not the session workspace's deck: `#/workflows` is a bare route
// with no session, so there is no workspace and no deck on it. The pane body is resolved
// through the pane board on the surface context, the deck's own single mount door, so
// this surface renders the same body the deck will. The board is read off the context
// rather than the process-wide singleton, because a test and an auxiliary window compose
// their own. A kind with no registered body draws an absence.
//
// The open address is held against the bridge: a bridge swap replaces it without
// unmounting this host, and an address outliving the bridge that served the run it names
// would open a pane on a run the next bridge has never heard of. It re-mints during the
// render that brings the new bridge.

import { useCallback } from "react";

import type { ConsolePaneAddress, ConsoleSurfaceContext } from "../seats/index.js";
import { useSubjectScopedState } from "../store/index.js";
import { OpenPaneBody } from "./OpenPaneBody.js";
import { WorkflowsDestination } from "./destination/index.js";

/** What the surface seat hands the workflows slot. */
export interface WorkflowsPaneHostProps {
  /**
   * The whole surface context, because a pane context is composed from it.
   *
   * A pane body is handed a bridge, both stores, the window store and its own address, and
   * composing that from a few inputs would mean the seat passing six.
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
  // Addressed by the bridge and by nothing else: opening a pane is answering one daemon.
  const { value: openAddress, publish: setOpenAddress } = useSubjectScopedState<
    ConsolePaneAddress | undefined
  >(context.bridge, undefined, () => undefined);
  // Stable across every render that did not re-address, so the destination's memoized
  // children are not handed a fresh action each pass; the publisher the holder gives
  // back moves exactly when the bridge does, which is when they should be.
  const openPane = useCallback(
    (address: ConsolePaneAddress) => {
      // Warmed BEFORE the address is published, which is what makes this a preload
      // rather than a second load: publishing re-renders this host and mounts the pane,
      // and a loader-backed body reached at that mount would show its fallback
      // first. One statement earlier, the fetch is already in flight. The mount is what
      // waits for the body; a rejected preload is not caught here.
      void paneRegistry.preload(address.kind);
      setOpenAddress(address);
    },
    [paneRegistry, setOpenAddress],
  );
  const closePane = useCallback(() => {
    setOpenAddress(undefined);
  }, [setOpenAddress]);

  if (openAddress === undefined) {
    return <WorkflowsDestination openPane={openPane} />;
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
      <OpenPaneBody address={openAddress} context={context} />
    </div>
  );
}
