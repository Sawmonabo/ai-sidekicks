// What a route renders while its screen's module is still arriving, drawn by the registry, and
// what the router draws for a reserved screen whose owner has not registered it yet: the
// `ScreenNotice` absence frame, empty. It is not any of the app's empty states, since those are
// claims about data and no read has been attempted (see `registries/panes/PendingPaneBody.tsx`).

import { ScreenNotice } from "#renderer/components/ScreenNotice/ScreenNotice.js";

/** The route's frame before its screen. */
export function PendingScreenBody(): React.JSX.Element {
  return <ScreenNotice />;
}
