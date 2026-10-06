import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowStepReviewPause } from "@ai-sidekicks/contracts/workflow/run/step";
import type { WorkflowRunReview } from "@ai-sidekicks/contracts/workflow/run/records";

import type { WorkflowCallState } from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import { RunControl } from "#renderer/features/workflows/components/RunControl.js";

/**
 * The snapshots `Open in Review` compares, or why they could not be taken: the run's own, from
 * its start to its end, or an approval step's, from the run's start to that pause.
 */
export type ReviewSnapshots = WorkflowRunReview | WorkflowStepReviewPause;

/** The press sends nothing of its own. */
const NOTHING_SENT: WorkflowCallState<unknown> = { kind: "idle" };

/**
 * `Open in Review`, the run page's one name for opening what the run changed: from the run's start
 * to its end on the header, to the pause on an approval step. Where a snapshot could not be taken
 * it stays in place, disabled, saying why it cannot open.
 */
export function OpenInReview(props: {
  readonly snapshots: ReviewSnapshots;
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
}): React.JSX.Element {
  const { snapshots } = props;
  return (
    <RunControl
      label="Open in Review"
      availability={
        snapshots.state === "pinned"
          ? { kind: "allowed" }
          : { kind: "refused", reason: snapshots.reason }
      }
      act={NOTHING_SENT}
      onPress={() => {
        if (snapshots.state === "pinned") {
          props.onOpenReview({ epoch: snapshots.epoch, point: "start" }, comparedEnd(snapshots));
        }
      }}
    />
  );
}

/** Where the comparison ends: the approval's pause, or the run's end. */
function comparedEnd(
  snapshots: Extract<ReviewSnapshots, { state: "pinned" }>,
): WorkflowRunSnapshotPoint {
  return "pauseNumber" in snapshots
    ? { epoch: snapshots.epoch, point: "pause", pauseNumber: snapshots.pauseNumber }
    : { epoch: snapshots.epoch, point: "end" };
}
