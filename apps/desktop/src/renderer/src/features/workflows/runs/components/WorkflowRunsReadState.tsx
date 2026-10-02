// What the destination's runs section shows for one read state. Each arm is a different fact:
// nobody could ask, the read is in flight, or an answer came back. An answer of no runs is a
// real one that `RunList` draws as its `empty` state.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RunList } from "./RunList.js";
import type { RunListProjection, WorkflowRunListRow } from "../run-list-projection.js";
import type { SubjectRead } from "../../subject-read-start.js";

/**
 * The runs read as the section draws it: the served arm carries the projection built from the
 * served runs, so a served read without one is not representable.
 */
export type WorkflowRunsReading = SubjectRead<{
  readonly status: "served";
  readonly projection: RunListProjection;
}>;

/** What the runs section body draws: the read and how a run opens. */
export interface WorkflowRunsReadStateProps {
  readonly reading: WorkflowRunsReading;
  /** Opens one run. Absent while the screen that mounts the section cannot address one. */
  readonly onOpenRun: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The runs section's body for whichever state its read is in. */
export function WorkflowRunsReadState(props: WorkflowRunsReadStateProps): React.JSX.Element | null {
  const { reading } = props;
  switch (reading.status) {
    case "unasked":
      // No session is in scope, so there is nothing to draw.
      return null;
    case "reading":
      return <Nothing kind="not-loaded" placement="block" title="Reading this session's runs." />;
    case "served":
      return <RunList projection={reading.projection} onOpenRun={props.onOpenRun} />;
  }
}
