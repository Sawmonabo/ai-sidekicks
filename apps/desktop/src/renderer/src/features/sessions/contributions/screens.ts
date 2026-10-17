// The sessions feature's screen registration: the window's start screen.

import { createElement } from "react";

import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";
import { SessionsScreen } from "../SessionsScreen.js";

/** Register the sessions screen. */
export function registerSessionsScreen(registry: ScreenRegistry): void {
  registry.register({
    name: "sessions",
    owner: "sessions",
    render: (context) => createElement(SessionsScreen, { frameStore: context.frameStore }),
  });
}
