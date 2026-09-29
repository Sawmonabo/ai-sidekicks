// The palette's scoped-context row: what a command would act on if run now.

import type { AppRoute } from "@renderer/routing/routes.js";

/**
 * Name what the palette's commands act on for `route`.
 *
 * A palette listing "Interrupt the run" without naming which run invites a mistake.
 */
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
