// The workflows feature's screen, the rail's workflows destination.

import {
  type ScreenRegistration,
  type ScreenRegistry,
} from "#renderer/registries/screens/registry.js";
import type { WorkflowCommandTargets } from "../command-target.js";
import { WORKFLOWS_OWNER } from "./panes.js";

/**
 * Claim this feature's screen, the rail's workflows destination, against a registry rather than the
 * module-scope singleton, so a test can compose its own set. The screen offers `commandTargets` to
 * the commands that press them.
 */
export function registerWorkflowScreens(
  registry: ScreenRegistry,
  commandTargets: WorkflowCommandTargets,
): void {
  const registration: ScreenRegistration = {
    name: "workflows",
    owner: WORKFLOWS_OWNER,
    // A loader: a `render` here would put the screen and run list on every session's initial
    // graph.
    body: () =>
      import("../screen-body.js").then((module) => ({
        Body: module.bodyOffering(commandTargets),
      })),
  };
  registry.register(registration);
}
