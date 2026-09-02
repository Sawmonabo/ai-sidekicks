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
// AN ADDRESS IS CHECKED BEFORE IT IS USED. A pane carries a `ConsoleEntityRef`, and
// the store registers `workflow-definition` and `workflow-run` as two kinds
// deliberately — a definition is authored, versioned and scoped and outlives every
// run of it. This pane authors the first. It used to read `entity.id` on any kind at
// all, so a run id addressed here would have been carried into the definition read
// and whatever came back would have been presented as the definition a person asked
// to edit. The guard is a typed refusal rather than a throw, because one
// mis-addressed pane must not take the deck down with it, and rather than a silent
// empty arm, because a surface that renders nothing tells nobody what is wrong.
//
// GEOMETRY IS NOT DEFINITION BYTES. Canvas layout is client-local: dragging a node
// changes no byte, mints no content hash and creates no version. The chrome states it
// here because the chrome is what frames the canvas and would otherwise be the
// natural place for someone to persist a viewport into the definition it is editing.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method, so the whole
// plane lives on the growth port behind the workflow slate row. The definition
// ENUMERATION is reachable there and the browser on the no-subject arm puts it; the
// definition read, the version read and the submission that saves are not on the
// port at all, so the addressed arm renders their absence and calls nothing.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { refusedWorkflowChrome } from "../../workflows/chrome-state.js";
import { WorkflowsBrowser } from "../../workflows/WorkflowsBrowser.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import {
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  unregisteredAuthoringAct,
} from "./builder-authoring.js";
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
  const { bridge, entity, sessionStore, uiStateStore, draftStore } = props.context;

  if (entity === undefined) {
    // The browser rather than the bare chrome, and with a session behind it: a pane
    // always names one, which is the input the definition enumeration requires and
    // the rail's own destination does not have. So the same browser that renders
    // three empty named groups at the rail renders what this session can actually
    // see here.
    return <WorkflowsBrowser growth={bridge.growth} sessionId={sessionStore?.sessionId} />;
  }

  if (entity.kind !== WORKFLOW_BUILDER_SUBJECT_KIND) {
    // The chrome's own `refused` arm, which renders the refusal and NOT the
    // children — so the two reserved bodies stay unmounted and no read is composed
    // for an id this surface cannot use. A banner across the surface rather than a
    // card in the ledger, because nothing entered the session's history here: what
    // changed is what this whole surface can do, which is nothing.
    return (
      <WorkflowChrome
        glyph="workflow"
        heading={HEADING}
        summary={SUMMARY}
        state={refusedWorkflowChrome(misaddressedBuilderPane(entity.kind))}
      />
    );
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
