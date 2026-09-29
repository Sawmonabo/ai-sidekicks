// What a route renders while its screen's module is still arriving.
//
// THE SCREEN'S OWN ABSENCE FRAME, EMPTY. `primitives/ScreenNotice` is the console's
// one answer to "the whole screen has nothing in it": a centered measure at the scale of
// the window, which is what keeps a quiet line from reading as a page that failed to
// finish painting. A route waiting on a chunk is exactly that scale of nothing, so it
// takes the same frame rather than a second one, and takes it EMPTY.
//
// EMPTY, AND NOT ONE OF THE FIVE KINDS OF NOTHING. `PendingPaneBody`'s module states the
// reasoning and it holds here without change: the five absences are claims about
// the entity, and none of them is true of a module that has not landed. `not loaded`
// would say the route's data had not arrived, which is a different sentence and a false
// one — no read has been attempted.
//
// The marker `registries/panes/PendingPaneBody.tsx` owns rides a `hidden` element for that module's
// reason: `display: none` contributes no box, so what the reserved region costs the
// layout is nothing.

import { ScreenNotice } from "@renderer/components/ScreenNotice/ScreenNotice.js";
import type { ScreenContext } from "./screen-context.js";
import { PENDING_BODY_ATTRIBUTE } from "@renderer/components/LazyBody/pending-body-marker.js";

export interface PendingScreenBodyProps {
  /** The route and bindings this screen was mounted at. */
  readonly context: ScreenContext;
}

/**
 * The route's frame, before its screen.
 *
 * The marker's VALUE is the route kind rather than a screen name, so a refusal to
 * capture names the address a person would recognize. It is the same attribute a pending
 * pane stamps, because the question a capture asks is one question — is anything on this
 * page still loading — and two attributes would be two sweeps that agree until one is
 * forgotten.
 */
export function PendingScreenBody(props: PendingScreenBodyProps): React.JSX.Element {
  return (
    <ScreenNotice>
      <span hidden {...{ [PENDING_BODY_ATTRIBUTE]: props.context.route.kind }} />
    </ScreenNotice>
  );
}
