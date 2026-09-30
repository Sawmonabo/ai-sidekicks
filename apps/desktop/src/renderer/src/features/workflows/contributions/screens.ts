// The workflows feature's screen, the rail's workflows destination.

import {
  type ScreenRegistration,
  type ScreenRegistry,
} from "@renderer/registries/screens/screen-registry.js";
import { WORKFLOWS_OWNER } from "./panes.js";

/** The screen this feature claims: the rail's workflows destination. */
const WORKFLOW_SCREENS: readonly ScreenRegistration[] = [
  {
    name: "workflows",
    owner: WORKFLOWS_OWNER,
    // A loader: a `render` here would put the screen and run list on every session's initial
    // graph.
    body: () => import("../workflows-screen-body.js"),
  },
];

/**
 * Claim this feature's screens against a registry rather than the module-scope singleton, so a
 * test or an auxiliary window can compose its own set.
 */
export function registerWorkflowScreens(registry: ScreenRegistry): void {
  for (const descriptor of WORKFLOW_SCREENS) {
    registry.register(descriptor);
  }
}
