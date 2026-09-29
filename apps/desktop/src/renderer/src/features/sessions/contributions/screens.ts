// The sessions feature's screen registration: the all-sessions flyout the rail mounts.

import { createElement } from "react";

import type { ScreenRegistry } from "@renderer/console/seats/index.js";
import { SessionsFlyout } from "../SessionsFlyout.js";

/** Claim the sessions screen slot. */
export function registerSessionsFlyout(registry: ScreenRegistry): void {
  registry.register({
    slot: "sessions",
    owner: "sessions",
    render: () => createElement(SessionsFlyout),
  });
}
