// The workflows feature's screen, the rail's workflows destination.

import { type ScreenRegistration, type ScreenRegistry } from "@renderer/console/seats/index.js";
import { WORKFLOWS_OWNER } from "./panes.js";

/** The screen slot this family claims: the rail's workflows destination. */
const WORKFLOW_SCREENS: readonly ScreenRegistration[] = [
  {
    slot: "workflows",
    owner: WORKFLOWS_OWNER,
    // A loader: the rail destination paints nothing until a person asks, and a `render`
    // here would put the host and the run list on every session's initial graph.
    body: () => import("../workflows-screen-body.js"),
  },
];

/**
 * Claim this family's screen slots against a registry.
 *
 * Takes the registry rather than the module-scope singleton, for
 * `registerWorkflowPanes`' reason: a test composes the same surfaces into a registry
 * it owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowScreens(registry: ScreenRegistry): void {
  for (const descriptor of WORKFLOW_SCREENS) {
    registry.register(descriptor);
  }
}
