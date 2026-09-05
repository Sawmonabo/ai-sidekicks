// The builder pane's chrome: a header, the one act it offers, and the canvas's slots.
//
// The node graph itself — the entry node and the four phase classes, the gate on a
// phase's outgoing shoulder, the one sequence edge kind, and the connection-validity
// predicate that refuses a shape DURING the drag rather than at save — is Plan-017's
// body, mounted through this directory's typed slots. What this file owns is the
// frame around them and the answer to the question a builder pane asks before it can
// draw anything: which definition am I editing?
//
// A PANE THAT NAMES NO DEFINITION SAYS SO, and stops there. It used to render the
// definitions browser instead, on the grounds that "pick one, or start one" is what a
// person needs when the builder has no subject — but neither half of that was true
// here. The browser was mounted with no navigation callback, so no name in it could
// be picked; and nothing in this build can start a definition, because every
// authoring act submits a definition body and no such operation is on the bridge. The
// result was a read-only copy of the list a person had just pressed a button in,
// from which nothing could advance. So the arm renders one absence saying what this
// pane is and what it cannot do — `builder-authoring.ts` owns the words — and the
// surface that used to offer the entry point withholds it, which is this family's
// absent-not-disabled rule applied to its own control.
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
// plane lives on the growth port behind the workflow slate row. The definition read,
// the version read and the submission that saves are not on that port at all, which
// is why every arm of this pane renders an absence and calls nothing: this file puts
// no read of its own, on any address, in this build.

import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { WorkflowChrome } from "../../WorkflowChrome.js";
import { refusedWorkflowChrome } from "../../chrome-state.js";
import type { ConsolePaneContext } from "../../../seats/index.js";
import {
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  unaddressedBuilderPane,
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
  const { uiStateStore, draftStore } = props.context;
  // Read through the address's own discriminant, because that is what carries the
  // entity: `ConsolePaneAddress` is a kind-scoped union, so a session-scoped arm has
  // no `entity` member at all and only the arms that take one publish it. The two
  // guards below are the FAIL-CLOSED PROJECTION of that union rather than a
  // substitute for it — a pane address is also PARSED, out of a persisted layout an
  // older build wrote and out of a route, and a parsed value is data rather than a
  // proof.
  const entity = "entity" in props.context ? props.context.entity : undefined;

  if (entity === undefined) {
    // The chrome's `empty` arm, which renders the absence and NOT the children — so
    // no slot is mounted for a definition that was never named. No primary action
    // travels with it either: the `empty` arm draws whatever action it is handed
    // beside the absence, and the one act this surface draws saves a definition
    // there is none of.
    return (
      <WorkflowChrome
        glyph="workflow"
        heading={HEADING}
        summary={SUMMARY}
        state={unaddressedBuilderPane()}
      />
    );
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
