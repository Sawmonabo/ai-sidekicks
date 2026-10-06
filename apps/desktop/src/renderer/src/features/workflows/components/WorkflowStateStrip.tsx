// What every workflows body leads with: one line saying what it is for, and whichever empty state
// or refusal the current state calls for. It draws no heading and no frame: the pane frame's
// crumb trail is the pane's accessible name, so a second heading would name it twice.
// A refusal is not an empty state: it keeps the daemon's code in mono and message verbatim, and
// folding it into an empty state would drop the code a person pastes into a search.

import "./WorkflowStateStrip.css";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { RefusalBanner } from "#renderer/components/Refusal/RefusalBanner.js";
import { type WorkflowStripState } from "../strip-state.js";

/** What a workflows body is handed: a summary line, a state, and the body for `ready`. */
export interface WorkflowStateStripProps {
  /** One line under the host's head saying what this view is for. */
  readonly summary: string;
  readonly state: WorkflowStripState;
  /** The view's body. Rendered on `ready` and on no other arm. */
  readonly children?: React.ReactNode;
}

/**
 * A workflows body's lead: its summary, and whatever its state calls for. A plain box, not a
 * landmark, because its host (the pane frame or the destination) already is one.
 */
export function WorkflowStateStrip(props: WorkflowStateStripProps): React.JSX.Element {
  return (
    <div className="meridian-workflow__strip">
      <p className="meridian-workflow__summary">{props.summary}</p>
      {renderState(props)}
    </div>
  );
}

// Exhaustive over `WorkflowStripState`, so a new arm is a compile error at one site.
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
