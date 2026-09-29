// Registers the pane harness screen. Only a fixture launch's composition calls it.

import { createElement } from "react";

import { type PaneRegistry, type ScreenRegistry } from "@renderer/console/seats/index.js";
import { PaneHarnessScreen } from "./PaneHarnessScreen.js";

/**
 * Claim the harness slot.
 *
 * Both registries are parameters, so a composition that owns its own boards registers
 * into them and resolves pane bodies from them, never from the production singletons.
 */
export function registerPaneHarnessScreen(
  surfaceRegistry: ScreenRegistry,
  paneRegistry: PaneRegistry,
): void {
  surfaceRegistry.register({
    slot: "pane-harness",
    owner: "pane-harness",
    render: (context) => createElement(PaneHarnessScreen, { context, paneRegistry }),
  });
}
