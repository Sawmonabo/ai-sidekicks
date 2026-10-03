// The run pane's body inside `PaneFrame`, which supplies the chrome on every arm so a refused
// pane can still be closed. Arms: no entity (empty state plus the conversational start, offered
// only here), another kind (the strip's refusal alone), an addressed run (the summary line).
// The address is checked though `PaneAddress` forbids other kinds: a parsed layout or route is
// data.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { ChatStartMountPoint } from "./components/ChatStartMountPoint.js";
import { WorkflowStateStrip } from "../components/WorkflowStateStrip.js";
import { refusedWorkflowStrip } from "../strip-state.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { WORKFLOW_RUN_PANE_SUBJECT_KIND, misaddressedRunPane } from "./run-addressing.js";

/** What this pane is for, in the one line that stands under its head. */
const SUMMARY = "One run's state, its phases, and why anything is parked.";

/** The context the pane layout resolved for a `workflow-run` pane. */
export interface RunPageProps {
  readonly context: PaneContextOf<"workflow-run">;
}

/** The body of a run pane, drawn inside the pane chrome's frame. */
export function RunPage(props: RunPageProps): React.JSX.Element {
  const { sessionStore } = props.context;
  // Widened on purpose: the address is also parsed from a persisted layout and a route, so the
  // guards below are live code.
  const entity: EntityRef | undefined = props.context.entity;
  const addressedRunId = entity?.kind === WORKFLOW_RUN_PANE_SUBJECT_KIND ? entity.id : undefined;

  // One frame for every arm, so a head and its body cannot disagree.
  function renderBody(): React.JSX.Element {
    if (entity === undefined) {
      return (
        <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }}>
          <Nothing kind="empty" placement="block" title="This pane names no run." />
          <ChatStartMountPoint sessionId={sessionStore?.sessionId} />
        </WorkflowStateStrip>
      );
    }

    if (entity.kind !== WORKFLOW_RUN_PANE_SUBJECT_KIND) {
      // The strip's `refused` arm renders the refusal and not the children, so no start
      // affordance stands beside an address this pane will not open.
      return (
        <WorkflowStateStrip
          summary={SUMMARY}
          state={refusedWorkflowStrip(misaddressedRunPane(entity.kind))}
        />
      );
    }

    return <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }} />;
  }

  return (
    <PaneFrame
      kind="workflow-run"
      sessionId={sessionStore?.sessionId}
      // Only a run the address names: a head scoped to a refused definition id would contradict
      // the banner beneath.
      runId={addressedRunId}
      // Passed through when absent: an unattributed pane sets no hue and the sheet's
      // neutral fallback applies.
    >
      {renderBody()}
    </PaneFrame>
  );
}
