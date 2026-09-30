// The run pane's body: the address checks and the three bodies that stand inside the
// pane's frame.
//
// `components/PaneFrame` draws the section, its accessible name, the breadcrumb and the
// actor's hue for every pane kind; this file returns only the body that goes inside it.
// The frame is worn on every arm, so a pane that refused its address can still be closed.
// Neither host control (close, tear off) is defaulted here: they are the pane layout's acts and
// reach the chrome through the host context, so no handler is threaded on any arm.
//
// The bodies:
//
//   - No entity: the empty state and the conversational start. The start is offered on
//     this arm and no other, so it never competes with a run already in front of the
//     operator.
//   - An entity of another kind: the strip's refusal, with nothing standing beside it.
//   - An addressed run: the strip's summary line.
//
// The chrome's trail is told the run only where the address names one, so a pane that
// refused a definition id does not announce itself as scoped to it.
//
// The address is checked before it is used, although `PaneAddress` makes another
// kind unconstructible: a pane address is also parsed out of a persisted layout and out of
// a route, and a parsed value is data rather than a proof. The builder pane holds the same
// guard, and both refuse through `workflows/pane/pane-addressing.ts`.

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
  // Widened on purpose: this arm's `entity` is declared as a required run reference, but
  // `paneBodyForKind` narrows a context on its `kind` alone and a pane address is also
  // parsed from a persisted layout and a route. The annotation keeps the compiler from
  // calling the guards below dead.
  const entity: EntityRef | undefined = props.context.entity;
  // The id is taken from the address only where the address names a run.
  const addressedRunId = entity?.kind === WORKFLOW_RUN_PANE_SUBJECT_KIND ? entity.id : undefined;

  // One frame for every arm: the address the trail reads is decided once, so a head and
  // its body cannot disagree.
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
      // The strip's `refused` arm renders the refusal and not the children, so no
      // control, mount point or start affordance stands beside an address this pane will not open.
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
      // Only a run the address names: a definition id is refused above, and a head scoped
      // to it would contradict the banner beneath.
      runId={addressedRunId}
      // Passed through when absent: an unattributed pane sets no hue and the sheet's
      // neutral fallback applies.
    >
      {renderBody()}
    </PaneFrame>
  );
}
