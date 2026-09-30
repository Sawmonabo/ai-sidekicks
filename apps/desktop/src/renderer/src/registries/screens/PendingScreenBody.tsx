// What a route renders while its screen's module is still arriving: the `ScreenNotice` absence
// frame, empty. It is not any of the console's absence states, since those are claims about data
// and no read has been attempted (see `registries/panes/PendingPaneBody.tsx`). The pending marker
// rides a `hidden` element, which adds no box.

import { ScreenNotice } from "@renderer/components/ScreenNotice/ScreenNotice.js";
import type { ScreenContext } from "./screen-context.js";
import { PENDING_BODY_ATTRIBUTE } from "@renderer/components/LazyBody/pending-body-marker.js";

/** Props for {@link PendingScreenBody}. */
export interface PendingScreenBodyProps {
  /** The route and bindings this screen was mounted at. */
  readonly context: ScreenContext;
}

/**
 * The route's frame before its screen. The marker value is the route kind, so a refused capture
 * names an address a person recognizes; it is the same attribute a pending pane stamps, so one
 * sweep answers whether anything is still loading.
 */
export function PendingScreenBody(props: PendingScreenBodyProps): React.JSX.Element {
  return (
    <ScreenNotice>
      <span hidden {...{ [PENDING_BODY_ATTRIBUTE]: props.context.route.kind }} />
    </ScreenNotice>
  );
}
