// The builder pane's chrome: a header, the canvas's slot, and the way in.
//
// The node graph itself — two node kinds, one edge kind, the connection-validity
// predicate that refuses a shape during the drag rather than at save — is Plan-017's
// body, mounted through `owner-slots.ts`. What this file owns is the frame around it
// and the answer to the question a builder pane asks before it can draw anything:
// which definition am I editing?
//
// A PANE THAT NAMES NO DEFINITION SHOWS THE DEFINITIONS BROWSER, and that is the
// design rather than a fallback. `Spec-023 §Console Design (Meridian)` §The surface
// set has the workflows rail destination open `workflow-builder`, and the browser's
// own empty state is "three named groups, all empty, plus entry points to the
// builder and to import" — which is exactly what a person needs when the builder has
// no subject: pick one, or start one. Rendering an empty canvas instead would be a
// surface offering an editor for a thing that does not exist yet.
//
// GEOMETRY IS NOT DEFINITION BYTES. Canvas layout is client-local, on the same tier
// as a human phase's form draft: dragging a node changes no byte, mints no content
// hash and creates no version. The chrome states it here because the chrome is what
// frames the canvas and would otherwise be the natural place to persist a viewport.

import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { WorkflowSlotMount } from "../../workflows/WorkflowSlotMount.js";
import { WorkflowsSurface } from "../../workflows/WorkflowsSurface.js";
import { WORKFLOW_DRAFT_SLOT, WORKFLOW_GRAPH_SLOT } from "../../workflows/owner-slots.js";
import { unaskedWorkflowChrome, type WorkflowChromeState } from "../../workflows/chrome-state.js";
import type { ConsolePaneContext } from "../../workspace/index.js";

/** The pane's absence once it HAS a definition: nobody has read it yet. */
const UNREAD: WorkflowChromeState = unaskedWorkflowChrome(
  "This definition has not been read in this window.",
  "The definition body arrives from the daemon; nothing was asked of it here.",
);

export interface WorkflowBuilderPaneProps {
  readonly context: ConsolePaneContext;
}

/** The builder pane's chrome. The canvas inside it is Plan-017's body. */
export function WorkflowBuilderPane(props: WorkflowBuilderPaneProps): React.JSX.Element {
  if (props.context.entity === undefined) {
    // `ready` and not `empty`: the browser HAS something to show — the three scope
    // groups, each carrying its own absence — and the surface renders its groups on
    // that arm. Handing it `empty` would collapse the whole browser into one line.
    return <WorkflowsSurface state={{ kind: "ready" }} />;
  }
  return (
    <WorkflowChrome
      glyph="workflow"
      heading="Workflow builder"
      summary="A definition as a graph, refused at the point a refused shape is drawn."
      state={UNREAD}
    >
      <WorkflowSlotMount
        slot={WORKFLOW_GRAPH_SLOT}
        title="The node graph is not built yet."
        detail="Phases, gates and their sequence edges are drawn here once the workflow engine's own canvas ships."
      />
      <WorkflowSlotMount
        slot={WORKFLOW_DRAFT_SLOT}
        title="The inspector's phase form is not built yet."
        detail="A phase's form configuration, tool binding and gate open here; nothing typed into them is ever written to disk."
      />
    </WorkflowChrome>
  );
}
