// The rail's workflows screen: the runs its mount supplies, or the pane a person opened from them.
// `#/workflows` names no session, so there is no pane layout: an opened pane replaces the runs,
// resolved through the pane board on the screen context. The open address is held against the
// bridge, so a swap drops it instead of opening a pane on a run the new bridge never heard of.

import "./WorkflowsScreen.css";

import { useCallback } from "react";

import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { OpenPaneBody } from "./components/OpenPaneBody.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import type { WorkflowRunListRow } from "./runs/run-list-projection.js";
import { WorkflowRuns } from "./runs/WorkflowRuns.js";

/** What the workflows screen is handed when it mounts. */
export interface WorkflowsScreenProps {
  /** The whole screen context, because a pane context is composed from it. */
  readonly context: ScreenContext;
  /** Where the run enumeration stands; when `undefined`, the runs section is not drawn. */
  readonly directory?: WorkflowRunDirectoryState;
}

/** The workflows screen: the runs it is handed, or the pane a person opened from them. */
export function WorkflowsScreen(props: WorkflowsScreenProps): React.JSX.Element {
  const { context, directory } = props;
  // The board this composition registered into, not the process-wide singleton, which would
  // warm production's board from a window handed its own.
  const { paneRegistry } = context;
  // Addressed by the bridge and by nothing else: opening a pane is answering one daemon.
  const { value: openAddress, publish: setOpenAddress } = useSubjectScopedState<
    PaneAddress | undefined
  >(context.bridge, undefined, () => undefined);
  const openPane = useCallback(
    (address: PaneAddress) => {
      // Warm before publishing the address: publishing mounts the pane, and a loader-backed body
      // reached at that mount would show its fallback first. A rejected preload is not caught.
      void paneRegistry.preload(address.kind);
      setOpenAddress(address);
    },
    [paneRegistry, setOpenAddress],
  );
  // Keyed on the opener alone: a fresh identity each pass would defeat the rows' memoization.
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
    <div className="meridian-workflows-open-pane">
      <button
        type="button"
        className="meridian-workflow__action meridian-workflows-open-pane__back"
        onClick={closePane}
      >
        Back to workflows
      </button>
      <OpenPaneBody address={openAddress} context={context} />
    </div>
  );
}
