// The builder pane's body: the canvas's mount points, or the refusal or empty state an address
// earns.
// The frame is the same on every arm, so a pane that refused its address is still closable.
// An address is checked before use: a run id addressed here is refused, never read as a
// definition id. Canvas geometry is client-local and is never persisted into the definition.

import { WorkflowStateStrip } from "../components/WorkflowStateStrip.js";
import { refusedWorkflowStrip } from "../strip-state.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import {
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  unaddressedBuilderPane,
} from "./builder-authoring.js";
import { DraftsMountPoint } from "./components/DraftsMountPoint.js";
import { NodeGraphMountPoint } from "./components/NodeGraphMountPoint.js";

/** What this pane is for, in the one line that stands under its head. */
const SUMMARY = "A definition as a graph, refused at the point a refused shape is drawn.";

/** What the pane layout hands the builder body: the pane's context, entity and stores included. */
export interface WorkflowBuilderPaneProps {
  readonly context: PaneContextOf<"workflow-builder">;
}

/** The builder pane's body. The canvas and the inspector inside it are the engine's. */
export function WorkflowBuilderPane(props: WorkflowBuilderPaneProps): React.JSX.Element {
  const { uiStateStore, draftStore, sessionStore } = props.context;
  // Widened on purpose: `paneBodyForKind` narrows on `kind` alone, and a pane address is parsed
  // from a persisted layout or a route, so the entity is unverified and the guards below stay live.
  const entity: EntityRef | undefined = props.context.entity;
  // The definition the trail and mount points are composed for; another kind names neither.
  const definition = entity?.kind === WORKFLOW_BUILDER_SUBJECT_KIND ? entity : undefined;

  // One frame on every arm, so the address the trail reads is decided once.
  function renderBody(): React.JSX.Element {
    if (entity === undefined) {
      // The strip's `empty` arm renders the empty state, not the children, so no mount point
      // mounts.
      return <WorkflowStateStrip summary={SUMMARY} state={unaddressedBuilderPane()} />;
    }

    if (definition === undefined) {
      // The `refused` arm renders the refusal, not the children, so no read is composed for an id
      // this pane cannot use.
      return (
        <WorkflowStateStrip
          summary={SUMMARY}
          state={refusedWorkflowStrip(misaddressedBuilderPane(entity.kind))}
        />
      );
    }

    return (
      <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }}>
        <NodeGraphMountPoint definitionId={definition.id} uiStateStore={uiStateStore} />
        <DraftsMountPoint definitionId={definition.id} draftStore={draftStore} />
      </WorkflowStateStrip>
    );
  }

  return (
    <PaneFrame
      kind="workflow-builder"
      sessionId={sessionStore?.sessionId}
      entity={definition}
      // Straight through, including absent: an unattributed pane sets no hue and the sheet's
      // neutral fallback applies.
    >
      {renderBody()}
    </PaneFrame>
  );
}
