// Registers the pane harness screen. Only a fixture launch's composition calls it.

import { createElement } from "react";

import { type PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { type ScreenRegistry } from "#renderer/registries/screens/screen-registry.js";
import { PaneHarnessScreen } from "./PaneHarnessScreen.js";

/**
 * Claim the harness screen.
 *
 * Both registries are parameters, so a composition that owns its own boards registers
 * into them and resolves pane bodies from them, never from the production singletons.
 */
export function registerPaneHarnessScreen(
  screenRegistry: ScreenRegistry,
  paneRegistry: PaneRegistry,
): void {
  screenRegistry.register({
    name: "pane-harness",
    owner: "pane-harness",
    render: (context) => {
      // The router mounts this screen only for its own route; any other is a composition defect.
      if (context.route.kind !== "pane-harness") {
        throw new Error(`the pane harness screen was mounted for a ${context.route.kind} route`);
      }
      return createElement(PaneHarnessScreen, { context, route: context.route, paneRegistry });
    },
  });
}
