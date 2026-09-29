// Registers the pane harness screen, in a fixture build and in no other.

import { createElement } from "react";

import {
  type ConsolePaneRegistry,
  type ConsoleSurfaceRegistry,
} from "@renderer/console/seats/index.js";
import { PaneHarnessSurface } from "./PaneHarnessScreen.js";

/**
 * Claim the harness slot, in a fixture build and in no other.
 *
 * With fixtures compiled out, Rollup collapses the body and the whole harness leaves
 * the bundle. Both registries are parameters, so a composition that owns its own
 * boards registers into them and resolves pane bodies from them, never from the
 * production singletons.
 */
export function registerPaneHarnessSurface(
  surfaceRegistry: ConsoleSurfaceRegistry,
  paneRegistry: ConsolePaneRegistry,
): void {
  if (!__SIDEKICKS_CONSOLE_FIXTURES__) {
    return;
  }
  surfaceRegistry.register({
    slot: "pane-harness",
    owner: "pane-harness",
    render: (context) => createElement(PaneHarnessSurface, { context, paneRegistry }),
  });
}
