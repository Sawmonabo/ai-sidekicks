// The runs this session holds, under the definitions it started them from.
//
// WHY THE RUNS SIT ON THE DESTINATION. `RunList` projects an attention-ordered list
// — parked first, then active, then settled — and until this component nothing
// mounted it: the list and its projection were reachable only from their own tests,
// so the four-run attention view the family had built could not be reached by a
// person at all. The destination is where it belongs rather than in a pane, because
// the question the list answers ("what in this session is waiting on me") is asked
// BEFORE a run is chosen, and a pane can only be opened once one has been.
//
// WHY IT READS SEPARATELY FROM THE BROWSER. Two reads, two subjects, two absences.
// The definition enumeration answers "what could be started here" and the run
// enumeration answers "what is running here", and a session can legitimately have
// definitions and no runs. Folding them into one read state would make either
// absence look like the other's, and the refusal of one would silence the other.
//
// THE OPEN CONTROL IS ABSENT, NOT DISABLED, AND THE RAIL NOW SUPPLIES IT. `RunList`
// takes `onOpenRun` and renders a plain row when a caller supplies none. That was
// every caller until the destination could address a pane, so a person could read
// that a run was parked and could not reach the controls that lift it. The action is
// still the caller's rather than this section's: a runs list mounted somewhere with
// nowhere to send a row passes none, and gets rows of facts instead of dead buttons.

import { useId, useMemo } from "react";

import type { GrowthPort } from "../../bridge/index.js";
import { useReadSettlementAnnouncement } from "../read-announcement.js";
import { RunListProjection, type WorkflowRunListRow } from "./run-list-projection.js";
import { useWorkflowRunDirectory, type WorkflowRunDirectoryState } from "./run-directory.js";
import { WorkflowRunsReadState } from "./WorkflowRunsReadState.js";

export interface WorkflowRunsProps {
  readonly growth: GrowthPort;
  /**
   * The session whose runs these are. Required, unlike the browser's: this section
   * is mounted only once a scope has settled, so an undefined session here would be
   * a caller mounting a read it knows cannot be put.
   */
  readonly sessionId: string;
  /** Opens one run. Absent while the mounting surface cannot address one. */
  readonly onOpenRun?: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The session's runs, read once and drawn attention-first. */
export function WorkflowRuns(props: WorkflowRunsProps): React.JSX.Element {
  const directory = useWorkflowRunDirectory(props.growth, props.sessionId);
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
  return directory.status === "unavailable" ? directory.refusal.detail : undefined;
}
