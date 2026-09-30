// What every workflows body leads with: one line saying what it is for, and
// whichever of the two absence grammars the current state calls for.
//
// The two workflows views — the run view and the node-graph builder — differ in what
// they hold and agree completely on how they say they are holding nothing. The
// console design gives both the same two vocabularies, and written per view that
// agreement would be two absence blocks that drift in copy shape, which only the
// screenshot tier would ever notice.
//
// IT DRAWS NO HEADING AND NO FRAME. `PaneFrame` draws every pane's frame in the
// console, and a pane whose body also drew a heading would be named twice: the
// frame's crumb trail IS the pane's accessible name, so a second `<h*>` inside it is
// a heading with no region of its own and a second answer to what the pane is called.
// What is here is body-level and only body-level, and it stands beneath whichever
// head its host drew — the pane frame's for the two pane kinds, the destination's own
// for the Workflows screen, which is not a pane at all.
//
// THE TWO GRAMMARS ARE KEPT APART, DELIBERATELY. An absence is the console's own
// prose about a read; a refusal is the daemon's answer, rendered with its
// code in mono and its message verbatim. Collapsing the refusal arm into
// the `error` absence would drop the code — the string a person pastes into a search
// — and would have the workflows views paraphrasing a daemon they are required to quote.
//
// THE BANNER IS THE SHAPE, AND THAT IS A CHOICE ABOUT BLAST RADIUS RATHER THAN THE
// ONLY EXPORT AVAILABLE. Every refusal these views can reach changes what
// the whole view can do next — a run read that was denied leaves nothing
// to attach an inline refusal to, and a control denial on a run changes what the
// room can do with that run. The inline shape belongs on a control that was pressed
// and stays; when the workflows views grow those controls, they render their own.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import { type WorkflowStripState } from "../strip-state.js";

export interface WorkflowStateStripProps {
  /** One line under the host's head saying what this view is for. */
  readonly summary: string;
  readonly state: WorkflowStripState;
  /** The view's body. Rendered on `ready` and on no other arm. */
  readonly children?: React.ReactNode;
}

/**
 * A workflows body's lead: its summary, and whatever its state calls for.
 *
 * A plain box rather than a landmark, because its host already is one. The pane
 * chrome renders a `<section>` named by its crumb trail and the destination renders
 * one named by its heading; a second region here would put a nameless landmark
 * inside a named one and give a person navigating by region two stops for one
 * view.
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
      return <Nothing kind="not-loaded" placement="block" title={state.title} />;
    case "empty":
      return <Nothing kind="empty" placement="block" title={state.title} />;
    case "refused":
      return <RefusalBanner code={state.refusal.code} detail={state.refusal.detail} />;
    case "ready":
      return props.children;
  }
}
