import { useEffect } from "react";

import { railDestinationFor } from "#renderer/routing/readers.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { RAIL_ENTRY_TEMPLATES } from "#renderer/layout/NavigationRail/NavigationRail.js";

/**
 * Title the window after what it shows: the session's id on a session's page, since nothing this
 * window reads names a session yet, the destination's label elsewhere, and the app's name
 * otherwise. Main mirrors it onto the native window, so it is what the Window menu lists.
 */
export function useWindowTitle(ownerWindow: Window, route: AppRoute, appTitle: string): void {
  useEffect(() => {
    ownerWindow.document.title = windowTitleFor(route, appTitle);
  }, [ownerWindow, route, appTitle]);
}

function windowTitleFor(route: AppRoute, appTitle: string): string {
  if (route.kind === "session") {
    return route.sessionId;
  }
  const destination = railDestinationFor(route);
  return destination === undefined ? appTitle : RAIL_ENTRY_TEMPLATES[destination].label;
}
