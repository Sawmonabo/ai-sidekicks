// The builder pane's body: the one act it offers, and the canvas's slots.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip and the body box for every pane
// kind in the console; what this file returns is what stands inside it. So the pane is
// named by its whole address trail rather than by the words "Workflow builder", and
// the act below sits in the chrome's own `actions` slot rather than in a header of
// this family's — saving writes the definition this pane is addressed at, which makes
// it a PANE action and not a step inside the canvas.
//
// ONE CHROME AND THREE BODIES, not three chromes. A pane wears its frame on every arm
// — a pane that refused its address must still be closable — so the arms below decide
// only what stands inside the frame, and the definition the trail reads is decided
// once. It reaches the trail only where the address names one this pane authors: a
// head that announced a run id as this pane's subject would contradict the banner
// underneath it.
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
// the strip's `ready` arm is the one that renders children, so a pane that handed
// the strip a `not-checked` STATE would have its slots dropped silently — the read's
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
// changes no byte, mints no content hash and creates no version. It is stated here
// because this file is what composes the canvas and would otherwise be the natural
// place for someone to persist a viewport into the definition it is editing.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method, so the whole
// plane lives on the growth port behind the workflow slate row. The definition read,
// the version read and the submission that saves are not on that port at all, which
// is why every arm of this pane renders an absence and calls nothing: this file puts
// no read of its own, on any address, in this build.

import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { WorkflowStateStrip } from "../../WorkflowStateStrip.js";
import { refusedWorkflowStrip } from "../../strip-state.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../../seats/index.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
import {
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  unaddressedBuilderPane,
  unregisteredAuthoringAct,
} from "./builder-authoring.js";
import { DraftsSlot } from "./slots/DraftsSlot.js";
import { NodeGraphSlot } from "./slots/NodeGraphSlot.js";

/** What this pane is for, in the one line that stands under its head. */
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
  readonly context: PaneContextOf<"workflow-builder">;
}

/** The builder pane's body. The canvas and the inspector inside it are Plan-017's. */
export function WorkflowBuilderPane(props: WorkflowBuilderPaneProps): React.JSX.Element {
  const { uiStateStore, draftStore, sessionStore, focusHue } = props.context;
  // WIDENED ON PURPOSE, and the annotation is the whole of it. This arm's `entity` is
  // declared as a definition reference, but `paneBodyForKind` narrows a context on its
  // `kind` ALONE — the entity underneath is unverified — and a pane address is also
  // PARSED, out of a persisted layout an older build wrote and out of a route. A
  // parsed value is data rather than a proof, so the two guards below stay live and
  // this annotation is what keeps the compiler from calling them dead.
  const entity: ConsoleEntityRef | undefined = props.context.entity;
  // The definition the trail reads, and the one the slots are composed for: an entity
  // of another kind names neither, so both are absent on exactly the arm that refuses.
  const definition = entity?.kind === WORKFLOW_BUILDER_SUBJECT_KIND ? entity : undefined;

  /**
   * Which of the three bodies stands inside the frame.
   *
   * A closure rather than three returns each wrapping a frame of its own: the frame
   * is the same on every arm and duplicating it would be three places for the address
   * the trail reads to be decided, which is exactly how a head and its body come
   * apart.
   */
  function renderBody(): React.JSX.Element {
    if (entity === undefined) {
      // The strip's `empty` arm, which renders the absence and NOT the children — so
      // no slot is mounted for a definition that was never named.
      return <WorkflowStateStrip summary={SUMMARY} state={unaddressedBuilderPane()} />;
    }

    if (definition === undefined) {
      // The strip's own `refused` arm, which renders the refusal and NOT the
      // children — so the two reserved bodies stay unmounted and no read is composed
      // for an id this surface cannot use. A banner across the body rather than a
      // card in the ledger, because nothing entered the session's history here: what
      // changed is what this whole surface can do, which is nothing.
      return (
        <WorkflowStateStrip
          summary={SUMMARY}
          state={refusedWorkflowStrip(misaddressedBuilderPane(entity.kind))}
        />
      );
    }

    return (
      <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }}>
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This definition has not been read in this window."
          detail="The definition body and its version chain arrive from the daemon; nothing was asked of it here."
        />
        <NodeGraphSlot workflowDefinitionId={definition.id} uiStateStore={uiStateStore} />
        <DraftsSlot workflowDefinitionId={definition.id} draftStore={draftStore} />
      </WorkflowStateStrip>
    );
  }

  return (
    <ConsolePaneChrome
      kind="workflow-builder"
      sessionId={sessionStore?.sessionId}
      entity={definition}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the sheet's own neutral fallback applies, which is one answer rather than
      // a default written here and a fallback written there.
      focusHue={focusHue}
      // ON THE ADDRESSED ARM ALONE. The head is drawn on all three, and the act saves
      // the definition this pane holds — so a pane opened with nothing to author, or
      // handed a subject it will not open, offers no save. That is this family's
      // absent-not-disabled rule applied to its own act rather than a layout choice.
      actions={
        definition === undefined ? undefined : (
          <div className="meridian-workflow__authoring">
            <span className="meridian-workflow__authoring-label">Save</span>
            <InlineRefusal {...UNREACHABLE_PRIMARY_ACT} />
          </div>
        )
      }
    >
      {renderBody()}
    </ConsolePaneChrome>
  );
}
