import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";

import type { WorkflowActState } from "../../hooks/useWorkflowAct.js";
import { RunControl } from "../../components/RunControl.js";

/** One of a run's doors into Review: the two snapshots it compares, or why it cannot open. */
export type ReviewDoor =
  | {
      readonly state: "pinned";
      readonly from: WorkflowRunSnapshotPoint;
      readonly to: WorkflowRunSnapshotPoint;
    }
  | { readonly state: "missing"; readonly reason: string };

/** The act state of a door, which sends nothing of its own. */
const NOTHING_SENT: WorkflowActState<unknown> = { kind: "idle" };

/**
 * `Open in Review`, the run page's one name for opening what the run changed. A door whose
 * snapshot could not be taken stays in place, disabled, saying why it cannot open.
 */
export function OpenInReview(props: {
  readonly door: ReviewDoor;
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
}): React.JSX.Element {
  const { door } = props;
  return (
    <RunControl
      label="Open in Review"
      availability={
        door.state === "pinned" ? { kind: "allowed" } : { kind: "refused", reason: door.reason }
      }
      act={NOTHING_SENT}
      onPress={() => {
        if (door.state === "pinned") {
          props.onOpenReview(door.from, door.to);
        }
      }}
    />
  );
}
