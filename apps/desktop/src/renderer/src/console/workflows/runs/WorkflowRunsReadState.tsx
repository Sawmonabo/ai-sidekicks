// What the destination's runs section shows for one read state.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `WorkflowRuns.tsx`, which is the
// package's one-component-per-`.tsx` rule and not a preference: a module holding two
// components is a module whose name answers for one of them, and the second is
// reached only by reading the file. `primitives/ReadingNotice.tsx` is the precedent —
// a deep relative import from its host, and no door line, because nothing outside
// this family composes it.
//
// NAMED FOR ITS SECTION AND NOT FOR ITS JOB. `panes/workflow-run/RunReadState.tsx`
// already holds a component called `RunReadState`, and it draws a different thing:
// the state of ONE run inside its pane, where this draws the state of the read that
// enumerates a session's runs. Two files of the same name in one family would make
// every import site ambiguous to a reader and every failure message ambiguous to
// whoever gets it.
//
// EVERY ARM IS A DIFFERENT FACT and none of them is the others: nobody could ask, the
// read is in flight, it refused by name, or an answer came back — and an answer of no
// runs is a real answer that `RunList` draws as the EMPTY kind of nothing. Collapsing
// any two is the conflation the five kinds of nothing exist to prevent, and the
// refusal arm renders no list at all rather than an empty one, which would assert
// that this session holds no runs on the strength of a read that failed.

import { Nothing, RefusalBanner } from "../../primitives/index.js";
import { RunList } from "./RunList.js";
import type { RunListProjection, WorkflowRunListRow } from "./run-list-projection.js";
import type { WorkflowRunDirectoryState } from "./run-directory.js";

export interface WorkflowRunsReadStateProps {
  readonly directory: WorkflowRunDirectoryState;
  /** Built from the served state, so the two are narrowed together. */
  readonly projection: RunListProjection | undefined;
  /** Opens one run. Absent while the mounting surface cannot address one. */
  readonly onOpenRun: ((row: WorkflowRunListRow) => void) | undefined;
}

/** The runs section's body for whichever state its read is in. */
export function WorkflowRunsReadState(props: WorkflowRunsReadStateProps): React.JSX.Element {
  const { directory, projection } = props;
  switch (directory.status) {
    case "unasked":
      return (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No session is in scope."
          detail="Runs belong to a session; nothing was asked until one is chosen."
        />
      );
    case "reading":
      return <Nothing kind="not-loaded" placement="surface" title="Reading this session's runs." />;
    case "unavailable":
      return <RefusalBanner {...directory.refusal} />;
    case "served":
      // Narrowed by the same state the projection was built from, so the fallback is
      // unreachable rather than a second empty state competing with the list's own.
      return projection === undefined ? (
        <Nothing kind="not-loaded" placement="surface" title="Reading this session's runs." />
      ) : (
        <RunList projection={projection} onOpenRun={props.onOpenRun} />
      );
  }
}
