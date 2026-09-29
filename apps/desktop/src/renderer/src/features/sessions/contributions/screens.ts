// The sessions feature's screen registration: the all-sessions flyout the rail mounts.

import { createElement } from "react";

import type { ConsoleSurfaceRegistry } from "@renderer/console/seats/index.js";
import { SessionsFlyout } from "../SessionsFlyout.js";

/** Claim the sessions surface slot. */
export function registerSessionsSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "sessions",
    owner: "sessions",
    render: () => createElement(SessionsFlyout),
  });
}
