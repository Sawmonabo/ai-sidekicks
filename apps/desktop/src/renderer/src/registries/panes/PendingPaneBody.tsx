// What a pane renders while its body's module is still arriving: the pane's own chrome with an
// empty body. The chrome comes from the address, known before the module lands, so nothing moves
// when the body arrives. No spinner or skeleton: the chunk loads from local disk in a frame or two.
// It is not any of the console's absence states (not loaded, empty, error, not checked, unknown),
// since what is missing is a module, not data. It adds only the pending marker, so the screenshot
// tier can refuse to capture this frame.

import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import type { PaneContext } from "./pane-context.js";
import { PENDING_BODY_ATTRIBUTE } from "@renderer/components/LazyBody/pending-body-marker.js";

/** Props for {@link PendingPaneBody}. */
export interface PendingPaneBodyProps {
  /** The address and bindings the pane layout opened this pane at. */
  readonly context: PaneContext;
}

/**
 * The pane before its body. The marker rides a `hidden` element in the body box, not an attribute
 * on the chrome, so it adds no box and the chrome needs no module-loading prop. The close control
 * is not passed: it reaches the chrome through the layout's context, so the strip is identical
 * across the swap.
 */
export function PendingPaneBody(props: PendingPaneBodyProps): React.JSX.Element {
  const { context } = props;
  return (
    <PaneFrame
      kind={context.kind}
      sessionId={context.sessionStore?.sessionId}
      entity={"entity" in context ? context.entity : undefined}
    >
      <span hidden {...{ [PENDING_BODY_ATTRIBUTE]: context.kind }} />
    </PaneFrame>
  );
}
