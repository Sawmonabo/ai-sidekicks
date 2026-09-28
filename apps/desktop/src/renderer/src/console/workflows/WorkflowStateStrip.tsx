// What every workflows body leads with: one line saying what it is for, and
// whichever of the two absence grammars the current state calls for.
//
// The two surfaces in this family — the run view and the node-graph builder — differ in
// what they hold and agree completely on how they say they are holding nothing. The
// console design gives both the same two vocabularies, and written per surface that
// agreement would be two absence blocks that drift in copy shape, which only the
// screenshot tier would ever notice.
//
// IT DRAWS NO HEADING AND NO FRAME, AND THAT IS THE WHOLE OF WHAT CHANGED. This was
// the family's own pane chrome — a `<section>`, a kind glyph, an `<h2>` and a body
// box — drawn once per surface. `seats/ConsolePaneChrome` now draws every pane's
// frame in the console, and a pane whose body also drew a heading would be named
// twice: the chrome's crumb trail IS the pane's accessible name, so a second `<h*>`
// inside it is a heading with no region of its own and a second answer to what the
// pane is called. What is left here is body-level and only body-level, and it stands
// beneath whichever head its host drew — the pane chrome's for the two pane kinds,
// the destination's own for the rail surface that is not a pane at all.
//
// THE TWO GRAMMARS ARE KEPT APART, DELIBERATELY. An absence is the console's own
// prose about a read; a refusal is the daemon's answer, rendered with its
// code in mono and its message verbatim. Collapsing the refusal arm into
// the `error` absence would drop the code — the string a person pastes into a search
// — and would have this family paraphrasing a daemon it is required to quote.
//
// THE BANNER IS THE SHAPE, AND THAT IS A CHOICE ABOUT BLAST RADIUS RATHER THAN THE
// ONLY EXPORT AVAILABLE. Every refusal these surfaces can reach changes what
// the whole surface can do next — a run read that was denied leaves nothing
// to attach an inline refusal to, and a control denial on a run changes what the
// room can do with that run. The inline shape belongs on a control that was pressed
// and stays; when this family grows those controls, they render their own.

import { Nothing, RefusalBanner } from "../primitives/index.js";
import { type WorkflowStripState } from "./strip-state.js";

export interface WorkflowStateStripProps {
  /** One line under the host's head saying what this surface is for. */
  readonly summary: string;
  readonly state: WorkflowStripState;
  /** The surface's body. Rendered on `ready` and on no other arm. */
  readonly children?: React.ReactNode;
}

/**
 * A workflows body's lead: its summary, and whatever its state calls for.
 *
 * A plain box rather than a landmark, because its host already is one. The pane
 * chrome renders a `<section>` named by its crumb trail and the destination renders
 * one named by its heading; a second region here would put a nameless landmark
 * inside a named one and give a person navigating by region two stops for one
 * surface.
 */
export function WorkflowStateStrip(props: WorkflowStateStripProps): React.JSX.Element {
  return (
    <div className="meridian-workflow__strip">
      <p className="meridian-workflow__summary">{props.summary}</p>
      {renderState(props)}
    </div>
  );
}

/**
 * The state's own rendering, total over the union.
 *
 * A function beside the component rather than a branch inside its body: the switch
 * is exhaustive over `WorkflowStripState`, and keeping it here is what makes a
 * sixth arm a compile error at one site instead of a silently unrendered state at
 * three.
 */
function renderState(props: WorkflowStateStripProps): React.ReactNode {
  const { state } = props;
  switch (state.kind) {
    case "not-loaded":
      return <Nothing kind="not-loaded" placement="surface" title={state.title} />;
    case "empty":
      return <Nothing kind="empty" placement="surface" title={state.title} />;
    case "refused":
      return <RefusalBanner code={state.refusal.code} detail={state.refusal.detail} />;
    case "ready":
      return props.children;
  }
}
