// The runs this session holds, under the definitions it started them from.
//
// WHY THE RUNS SIT ON THE DESTINATION. The question the list answers ("what in this
// session is waiting on me") is asked BEFORE a run is chosen, and a pane can only be
// opened once one has been.
//
// WHY IT READS SEPARATELY FROM THE BROWSER. Two reads, two subjects, two absences.
// The definition enumeration answers "what could be started here" and the run
// enumeration answers "what is running here", and a session can legitimately have
// definitions and no runs. Folding them into one read state would make either
// absence look like the other's.
//
// THE OPEN CONTROL IS ABSENT, NOT DISABLED. `RunList` takes `onOpenRun` and renders a
// plain row when a caller supplies none: a runs list mounted somewhere with nowhere to
// send a row gets rows of facts instead of dead buttons.

import { useId, useMemo } from "react";

import { useReadSettlementAnnouncement } from "../../primitives/index.js";
import { RunListProjection, type WorkflowRunListRow } from "./run-list-projection.js";
import type { WorkflowRunDirectoryState } from "./run-directory.js";
import { WorkflowRunsReadState } from "./WorkflowRunsReadState.js";

/** What the runs section draws: the state of the session's run read, and how a run opens. */
export interface WorkflowRunsProps {
  /** Where the session's run enumeration stands. */
  readonly directory: WorkflowRunDirectoryState;
  /** Opens one run. Absent while the mounting surface cannot address one. */
  readonly onOpenRun?: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The session's runs, drawn newest first. */
export function WorkflowRuns(props: WorkflowRunsProps): React.JSX.Element {
  const { directory } = props;
  // Memoized on the read state: the projection sorts and derives per-row facts in
  // its constructor, and rebuilding it every render would redo that work and hand
  // `RunList` fresh row identities that defeat its per-row memoization.
  const projection = useMemo(
    () => (directory.status === "served" ? new RunListProjection(directory.runs) : undefined),
    [directory],
  );
  useReadSettlementAnnouncement(directory, runReadSentence(directory, projection));
  // Minted per mount rather than declared as a module constant, for the reason
  // `WorkflowsSurface.tsx` states about its own: a module constant is one id however
  // many of this section a tree holds, and two of them make both `aria-labelledby`
  // references resolve to whichever heading came first.
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
 * What this section says about a settled runs read, or nothing while it has not.
 *
 * A pure function of the state so the sentence is composed in the render that carries
 * the settlement, and the hook beside it owns only "once". The `served` arm waits on
 * the projection because the count is the projection's, not the read's.
 */
function runReadSentence(
  directory: WorkflowRunDirectoryState,
  projection: RunListProjection | undefined,
): string | undefined {
  if (directory.status === "served" && projection !== undefined) {
    // A count rather than a pluralized noun: the console has one figure formatter
    // and no pluralizer, and "Runs in this session: 0" is as true as any other
    // reading of it.
    return `Runs in this session: ${String(projection.rows.length)}.`;
  }
  return undefined;
}
