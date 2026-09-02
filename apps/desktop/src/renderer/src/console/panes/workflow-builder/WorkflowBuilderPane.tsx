// The builder pane's chrome: a header, the one act it offers, and the canvas's slots.
//
// The node graph itself — the entry node and the four phase classes, the gate on a
// phase's outgoing shoulder, the one sequence edge kind, and the connection-validity
// predicate that refuses a shape DURING the drag rather than at save — is Plan-017's
// body, mounted through this directory's typed slots. What this file owns is the
// frame around them and the answer to the question a builder pane asks before it can
// draw anything: which definition am I editing?
//
// A PANE THAT NAMES NO DEFINITION SHOWS THE DEFINITIONS BROWSER, and that is the
// design rather than a fallback. `Spec-023 §Console Design (Meridian)` §The surface
// set has the workflows rail destination open `workflow-builder`, and the browser's
// own empty state is "three named groups, all empty, plus entry points to the
// builder and to import" — which is exactly what a person needs when the builder has
// no subject: pick one, or start one. Rendering an empty canvas instead would be a
// surface offering an editor for a thing that does not exist yet.
//
// THE ADDRESSED ARM COMPOSES ITS OWN ABSENCE, on the shape the run pane established:
// the chrome's `ready` arm is the one that renders children, so a pane that handed
// the chrome a `not-checked` STATE would have its slots dropped silently — the read's
// absence would render and the two reserved bodies would not. So the pane says
// `ready`, renders the not-checked absence itself, and mounts both slots beneath it.
// Two facts, both true at once: nobody has read this definition in this window, and
// the bodies that would draw it are reserved and unbuilt.
//
// GEOMETRY IS NOT DEFINITION BYTES. Canvas layout is client-local: dragging a node
// changes no byte, mints no content hash and creates no version. The chrome states it
// here because the chrome is what frames the canvas and would otherwise be the
// natural place for someone to persist a viewport into the definition it is editing.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method and the growth
// port carries no workflow operation, so the definition read, the version read, the
// definition list and the submission that saves are all unreachable. The console
// renders their absence and calls nothing.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { WorkflowsSurface } from "../../workflows/WorkflowsSurface.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { WORKFLOW_BUILDER_PRIMARY_ACT, unregisteredAuthoringAct } from "./builder-authoring.js";
import { DraftsSlot } from "./slots/DraftsSlot.js";
import { NodeGraphSlot } from "./slots/NodeGraphSlot.js";

/** The surface's name and its one-line purpose, written once for both arms. */
const HEADING = "Workflow builder";
const SUMMARY = "A definition as a graph, refused at the point a refused shape is drawn.";

/**
 * The one act rule 7 lets this surface draw, in the state this build leaves it in.
 *
 * Computed once at module scope rather than per render: the refusal is a constant
 * of the build — no wire carries the operation — so recomputing it on every render
 * would be work whose result cannot differ.
 */
const UNREACHABLE_PRIMARY_ACT = unregisteredAuthoringAct(WORKFLOW_BUILDER_PRIMARY_ACT);

export interface WorkflowBuilderPaneProps {
  readonly context: ConsolePaneContext;
}

/** The builder pane's chrome. The canvas and the inspector inside it are Plan-017's. */
export function WorkflowBuilderPane(props: WorkflowBuilderPaneProps): React.JSX.Element {
  const { entity, uiStateStore, draftStore } = props.context;

  if (entity === undefined) {
    // `ready` and not `empty`: the browser HAS something to show — the three scope
    // groups, each carrying its own absence — and the surface renders its groups on
    // that arm. Handing it `empty` would collapse the whole browser into one line.
    return <WorkflowsSurface state={{ kind: "ready" }} />;
  }

  return (
    <WorkflowChrome
      glyph="workflow"
      heading={HEADING}
      summary={SUMMARY}
      state={{ kind: "ready" }}
      primaryAction={
        <div className="meridian-workflow__authoring">
          <span className="meridian-workflow__authoring-label">Save</span>
          <InlineRefusal {...UNREACHABLE_PRIMARY_ACT} />
        </div>
      }
    >
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This definition has not been read in this window."
        detail="The definition body and its version chain arrive from the daemon; nothing was asked of it here."
      />
      <NodeGraphSlot workflowDefinitionId={entity.id} uiStateStore={uiStateStore} />
      <DraftsSlot workflowDefinitionId={entity.id} draftStore={draftStore} />
    </WorkflowChrome>
  );
}
