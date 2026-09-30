// What the destination's runs section shows for one read state. Each arm is a different fact:
// nobody could ask, the read is in flight, or an answer came back. An answer of no runs is a
// real one that `RunList` draws as the `empty` absence.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RunList } from "./RunList.js";
import type { RunListProjection, WorkflowRunListRow } from "../run-list-projection.js";
import type { WorkflowRunDirectoryState } from "../hooks/useWorkflowRunDirectory.js";

/** What the runs section body draws: the read state, its projection, and how a run opens. */
export interface WorkflowRunsReadStateProps {
  readonly directory: WorkflowRunDirectoryState;
  /** Built from the served state, so the two are narrowed together. */
  readonly projection: RunListProjection | undefined;
  /** Opens one run. Absent while the screen that mounts the section cannot address one. */
  readonly onOpenRun: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The runs section's body for whichever state its read is in. */
export function WorkflowRunsReadState(props: WorkflowRunsReadStateProps): React.JSX.Element {
  const { directory, projection } = props;
  switch (directory.status) {
    case "unasked":
      // No session is in scope, so there is nothing to draw.
      return <></>;
    case "reading":
      return <Nothing kind="not-loaded" placement="block" title="Reading this session's runs." />;
    case "served":
      // Narrowed by the state the projection was built from, so the fallback is unreachable.
      return projection === undefined ? (
        <Nothing kind="not-loaded" placement="block" title="Reading this session's runs." />
      ) : (
        <RunList projection={projection} onOpenRun={props.onOpenRun} />
      );
  }
}
