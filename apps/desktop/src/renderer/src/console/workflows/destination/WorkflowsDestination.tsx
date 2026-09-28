// The rail's workflows destination: the runs a mounting surface supplies, and the way to open
// one.
//
// `#/workflows` is a bare route, so the surface context carries no session and the run
// enumeration arrives as a read state the mounting surface supplies. Without one, the
// destination draws its frame and no runs section.
//
// The opener is handed down rather than reached for, so the surface that mounts this
// destination decides where an opened pane lands. `openRun` is keyed on that opener alone: a
// fresh opener identity on every pass would defeat the rows' memoization under `WorkflowRuns`.

import { useCallback } from "react";

import type { ConsolePaneOpener } from "../../seats/index.js";
import type { WorkflowRunDirectoryState } from "../runs/run-directory.js";
import type { WorkflowRunListRow } from "../runs/run-list-projection.js";
import { WorkflowRuns } from "../runs/WorkflowRuns.js";

/** What a mounting surface hands the workflows destination. */
export interface WorkflowsDestinationProps {
  /**
   * Where the run enumeration stands. `undefined` when the mount supplies none, and then
   * the runs section is not drawn.
   */
  readonly directory?: WorkflowRunDirectoryState;
  /**
   * Where an opened pane goes. Required: a mount that supplied no opener would show runs
   * a person can read and cannot open.
   */
  readonly openPane: ConsolePaneOpener;
}

/** The workflows destination: the runs it is handed, and the way to open one. */
export function WorkflowsDestination(props: WorkflowsDestinationProps): React.JSX.Element {
  const { directory, openPane } = props;
  const openRun = useCallback(
    (row: WorkflowRunListRow) => {
      openPane({
        kind: "workflow-run",
        entity: { kind: "workflow-run", id: row.run.workflowRunId },
      });
    },
    [openPane],
  );

  return (
    <div className="meridian-workflows-destination">
      {directory === undefined ? null : <WorkflowRuns directory={directory} onOpenRun={openRun} />}
    </div>
  );
}
