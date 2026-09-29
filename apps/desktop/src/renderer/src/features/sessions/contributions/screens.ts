// The sessions family's door.
//
// One surface — the all-sessions frame the `sessions` rail destination mounts — and the
// stylesheets it renders through, imported here and nowhere else. The rest of the family
// is reached deeply from inside; a door onto a room with no other entrance is not a door.

import "../sessions.css";
import "@renderer/console/sessions/acts/session-acts.css";

import { createElement } from "react";

import type { ConsoleSurfaceRegistry } from "@renderer/console/seats/index.js";
import { SessionsSurface } from "../SessionsFlyout.js";

/** Claim the sessions surface slot. */
export function registerSessionsSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "sessions",
    owner: "sessions",
    render: () => createElement(SessionsSurface),
  });
}
