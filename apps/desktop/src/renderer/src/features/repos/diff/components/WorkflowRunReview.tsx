// Review over a workflow run: the file list and diff of what the run changed between the two
// snapshot points its address names, and nothing of the session's own Review around them (no
// scope row, base picker, notes or ship strip). Split from `DiffPane.tsx` so its read runs only for
// a run's address.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useWorkflowRunDiff } from "../hooks/useWorkflowRunDiff.js";
import type { WorkflowRunDiffRequest } from "../workflow-run-diff-read.js";
import { DiffChangeSet } from "./DiffChangeSet.js";

/** What the run's Review is drawn from: the daemon and the comparison to read. */
export interface WorkflowRunReviewProps {
  readonly bridge: PlatformBridge;
  readonly request: WorkflowRunDiffRequest;
}

/**
 * What one run changed: loading, the daemon's refusal with `Try again`, `This run changed no
 * files`, or the change set with each file marked by the step that changed it.
 */
export function WorkflowRunReview(props: WorkflowRunReviewProps): React.JSX.Element {
  const { state, readAgain } = useWorkflowRunDiff(props.bridge, props.request);
  if (state.kind === "not-loaded") {
    return (
      <div className="meridian-diff-pane__empty-state">
        <Nothing kind="not-loaded" placement="block" title="Loading what this run changed…" />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className="meridian-diff-pane__empty-state">
        <Nothing
          kind="error"
          placement="block"
          title="Could not load what this run changed"
          detail={state.refusal.detail}
          action={
            <button
              type="button"
              className={
                "meridian-action-button meridian-action-button--small " +
                "meridian-action-button--outline"
              }
              onClick={readAgain}
            >
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (state.value.files.length === 0) {
    return (
      <div className="meridian-diff-pane__empty-state">
        <Nothing kind="empty" placement="block" title="This run changed no files" />
      </div>
    );
  }
  return <DiffChangeSet diff={state.value} />;
}
