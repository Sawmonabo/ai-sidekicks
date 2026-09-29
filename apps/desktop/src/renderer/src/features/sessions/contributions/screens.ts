// The sessions feature's screen registration: the all-sessions flyout the rail mounts.

import { createElement } from "react";

import type { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { SessionsFlyout } from "../SessionsFlyout.js";

/** Register the sessions screen. */
export function registerSessionsFlyout(registry: ScreenRegistry): void {
  registry.register({
    name: "sessions",
    owner: "sessions",
    render: () => createElement(SessionsFlyout),
  });
}
