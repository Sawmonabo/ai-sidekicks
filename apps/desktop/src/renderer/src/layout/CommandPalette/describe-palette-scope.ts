// The palette's scope row: what a command acts on if run now.

import type { AppRoute } from "@renderer/routing/routes.js";

/** Names what the palette's commands act on for `route`, so "Interrupt the run" is unambiguous. */
export function describePaletteScope(route: AppRoute): string {
  switch (route.kind) {
    case "sessions":
      return "All sessions";
    case "session":
      return `Session ${route.sessionId}`;
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    case "pane-harness":
      // A command run from the harness acts on the session its panes are bound to.
      return `${route.paneKind} panes — session ${route.sessionId}`;
    case "not-found":
      return "Nowhere";
  }
}
