// The palette's scope row: what a command acts on if run now.

import type { AppRoute } from "#renderer/routing/routes.js";

/**
 * Names what the palette's commands act on for `route`, so "Interrupt the run" is unambiguous, or
 * `undefined` where there is no name to show and the row is not drawn. A session's row waits on
 * its title: its id is never drawn.
 */
export function describePaletteScope(route: AppRoute): string | undefined {
  switch (route.kind) {
    case "sessions":
      return "All sessions";
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    case "pane-harness":
      // Fixture-only: a command run from the harness acts on the session its panes are bound to.
      return `${route.paneKind} panes — session ${route.sessionId}`;
    case "session":
    case "not-found":
      return undefined;
  }
}
