// What a route renders while its surface's module is still arriving.
//
// THE SURFACE'S OWN ABSENCE FRAME, EMPTY. `primitives/SurfaceAbsence` is the console's
// one answer to "the whole surface has nothing in it": a centred measure at the scale of
// the window, which is what keeps a quiet line from reading as a page that failed to
// finish painting. A route waiting on a chunk is exactly that scale of nothing, so it
// takes the same frame rather than a second one, and takes it EMPTY.
//
// EMPTY, AND NOT ONE OF THE FIVE KINDS OF NOTHING. `PendingPaneBody`'s module states the
// reasoning and it holds here without change: rule 8's five absences are claims about
// the entity, and none of them is true of a module that has not landed. `not loaded`
// would say the route's data had not arrived, which is a different sentence and a false
// one — no read has been attempted.
//
// The marker `pending-pane-body.ts` owns rides a `hidden` element for that module's
// reason: `display: none` contributes no box, so what the reserved region costs the
// layout is nothing.

import { SurfaceAbsence } from "../primitives/index.js";
import type { ConsoleSurfaceContext } from "./surface-context.js";
import { PENDING_PANE_BODY_ATTRIBUTE } from "./pending-pane-body.js";

export interface PendingSurfaceBodyProps {
  /** The route and bindings this surface was mounted at. */
  readonly context: ConsoleSurfaceContext;
}

/**
 * The route's frame, before its surface.
 *
 * The marker's VALUE is the route kind rather than a surface slot, so a refusal to
 * capture names the address a person would recognise. It is the same attribute a pending
 * pane stamps, because the question a capture asks is one question — is anything on this
 * page still loading — and two attributes would be two sweeps that agree until one is
 * forgotten.
 */
export function PendingSurfaceBody(props: PendingSurfaceBodyProps): React.JSX.Element {
  return (
    <SurfaceAbsence>
      <span hidden {...{ [PENDING_PANE_BODY_ATTRIBUTE]: props.context.route.kind }} />
    </SurfaceAbsence>
  );
}
