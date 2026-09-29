// What the destination's runs section shows for one read state.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `WorkflowRuns.tsx`, which is the
// package's one-component-per-`.tsx` rule and not a preference: a module holding two
// components is a module whose name answers for one of them, and the second is
// reached only by reading the file. `WorkflowRuns.tsx` imports it by relative path and
// the feature's public entry does not export it, because nothing outside this feature
// composes it.
//
// EVERY ARM IS A DIFFERENT FACT and none of them is the others: nobody could ask (no
// session is in scope, so nothing is drawn), the read is in flight, or an answer came
// back — and an answer of no runs is a real answer that `RunList` draws as the EMPTY
// kind of nothing. Collapsing any two is the conflation the five kinds of nothing exist
// to prevent.

import { Nothing } from "@renderer/console/primitives/index.js";
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
      // Narrowed by the same state the projection was built from, so the fallback is
      // unreachable rather than a second empty state competing with the list's own.
      return projection === undefined ? (
        <Nothing kind="not-loaded" placement="block" title="Reading this session's runs." />
      ) : (
        <RunList projection={projection} onOpenRun={props.onOpenRun} />
      );
  }
}
