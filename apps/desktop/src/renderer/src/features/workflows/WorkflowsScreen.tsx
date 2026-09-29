// The rail's workflows screen: the runs a mounting surface supplies, and whichever pane a
// person opened from them.
//
// `#/workflows` is a bare route, so the screen context carries no session and the run
// enumeration arrives as a read state the mounting surface supplies. Without one, the screen
// draws its frame and no runs section.
//
// An opened pane replaces the runs, one at a time. That is not the session's pane layout:
// `#/workflows` names no session, so there is no layout on it. The pane body is resolved
// through the pane board on the screen context, the one the composition registered into,
// so this screen renders the same body a session's layout would. A kind with no registered
// body draws only the back control.
//
// The open address is held against the bridge: a bridge swap replaces it without
// unmounting this screen, and an address outliving the bridge that served the run it names
// would open a pane on a run the next bridge has never heard of.

import "./WorkflowsScreen.css";

import { useCallback } from "react";

import type { PaneAddress, ScreenContext } from "@renderer/console/seats/index.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { OpenPaneBody } from "./components/OpenPaneBody.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import type { WorkflowRunListRow } from "./runs/run-list-projection.js";
import { WorkflowRuns } from "./runs/WorkflowRuns.js";

/** What the screen seat hands the workflows screen. */
export interface WorkflowsScreenProps {
  /**
   * The whole screen context, because a pane context is composed from it.
   *
   * A pane body is handed a bridge, both stores, the window store and its own address, and
   * composing that from a few inputs would mean the seat passing six.
   */
  readonly context: ScreenContext;
  /**
   * Where the run enumeration stands. `undefined` when the mount supplies none, and then
   * the runs section is not drawn.
   */
  readonly directory?: WorkflowRunDirectoryState;
}

/** The workflows screen: the runs it is handed, or the pane a person opened from them. */
export function WorkflowsScreen(props: WorkflowsScreenProps): React.JSX.Element {
  const { context, directory } = props;
  // The board THIS composition registered its bodies into, off the screen context rather
  // than the process-wide singleton, which would warm production's board from a window
  // that had been handed its own.
  const { paneRegistry } = context;
  // Addressed by the bridge and by nothing else: opening a pane is answering one daemon.
  const { value: openAddress, publish: setOpenAddress } = useSubjectScopedState<
    PaneAddress | undefined
  >(context.bridge, undefined, () => undefined);
  const openPane = useCallback(
    (address: PaneAddress) => {
      // Warmed BEFORE the address is published, which is what makes this a preload rather
      // than a second load: publishing re-renders this screen and mounts the pane, and a
      // loader-backed body reached at that mount would show its fallback first. The mount
      // is what waits for the body; a rejected preload is not caught here.
      void paneRegistry.preload(address.kind);
      setOpenAddress(address);
    },
    [paneRegistry, setOpenAddress],
  );
  // Keyed on the opener alone: a fresh identity on every pass would defeat the rows'
  // memoization under `WorkflowRuns`.
  const openRun = useCallback(
    (row: WorkflowRunListRow) => {
      openPane({
        kind: "workflow-run",
        entity: { kind: "workflow-run", id: row.run.workflowRunId },
      });
    },
    [openPane],
  );
  const closePane = useCallback(() => {
    setOpenAddress(undefined);
  }, [setOpenAddress]);

  if (openAddress === undefined) {
    return (
      <div className="meridian-workflows-destination">
        {directory === undefined ? null : (
          <WorkflowRuns directory={directory} onOpenRun={openRun} />
        )}
      </div>
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
      <OpenPaneBody address={openAddress} context={context} />
    </div>
  );
}
