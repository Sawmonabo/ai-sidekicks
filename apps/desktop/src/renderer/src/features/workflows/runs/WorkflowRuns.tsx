// The runs this session holds. Read apart from the definitions: a session can have definitions
// and no runs, and one read state would make either absence look like the other's. The open
// control is absent, not disabled, when the caller supplies no `onOpenRun`.

import { useId, useMemo } from "react";

import { useReadSettlementAnnouncement } from "@renderer/hooks/useReadSettlementAnnouncement.js";
import { RunListProjection, type WorkflowRunListRow } from "./run-list-projection.js";
import type { WorkflowRunDirectoryState } from "./hooks/useWorkflowRunDirectory.js";
import { WorkflowRunsReadState } from "./components/WorkflowRunsReadState.js";

/** What the runs section draws: the state of the session's run read, and how a run opens. */
export interface WorkflowRunsProps {
  /** Where the session's run enumeration stands. */
  readonly directory: WorkflowRunDirectoryState;
  /** Opens one run. Absent while whatever mounts the list cannot address one. */
  readonly onOpenRun?: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The session's runs, drawn newest first. */
export function WorkflowRuns(props: WorkflowRunsProps): React.JSX.Element {
  const { directory } = props;
  // Memoized: the projection sorts and derives per-row facts on construction, and a fresh one
  // would hand `RunList` new row identities that defeat its per-row memoization.
  const projection = useMemo(
    () => (directory.status === "served" ? new RunListProjection(directory.runs) : undefined),
    [directory],
  );
  useReadSettlementAnnouncement(directory, runReadSentence(directory, projection));
  // Minted per mount: a module constant would make two sections' `aria-labelledby` collide.
  const headingId = useId();

  return (
    <section className="meridian-workflows-runs" aria-labelledby={headingId}>
      <h2 id={headingId} className="meridian-workflows-runs__heading">
        Runs
      </h2>
      <WorkflowRunsReadState
        directory={directory}
        projection={projection}
        onOpenRun={props.onOpenRun}
      />
    </section>
  );
}

/**
 * What this section says about a settled runs read, or nothing while it has not. The `served` arm
 * waits on the projection because the count is the projection's.
 */
function runReadSentence(
  directory: WorkflowRunDirectoryState,
  projection: RunListProjection | undefined,
): string | undefined {
  if (directory.status === "served" && projection !== undefined) {
    // A count, not a pluralized noun: the console has no pluralizer.
    return `Runs in this session: ${String(projection.rows.length)}.`;
  }
  return undefined;
}
