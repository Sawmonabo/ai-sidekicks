// The workflows feature's pane kinds, `workflow-run` and `workflow-builder`.

import {
  type PaneRegistration,
  type PaneRegistry,
} from "@renderer/registries/panes/pane-registry.js";

/**
 * The feature's owner string. One binding, because the registries' duplicate policy is
 * owner-scoped and a mistyped second literal would read as two features claiming one kind.
 */
export const WORKFLOWS_OWNER = "workflows";

/**
 * Both pane kinds this feature claims. Each body module applies `paneBodyForKind` itself,
 * since a loader-form registration carries a specifier, not a render.
 */
const WORKFLOW_PANES: readonly PaneRegistration[] = [
  {
    kind: "workflow-run",
    owner: WORKFLOWS_OWNER,
    // A loader: a run pane opens from the run list or a run address, so nothing paints it
    // before a person asks.
    body: () => import("../run-page/run-page-body.js"),
  },
  {
    kind: "workflow-builder",
    owner: WORKFLOWS_OWNER,
    // Its own chunk: the builder carries a sheet no other feature declares against, and
    // nothing paints it before a person asks.
    body: () => import("../builder/builder-pane-body.js"),
  },
];

/**
 * Claim this feature's pane kinds against a registry rather than the module-scope singleton, so
 * a test can compose its own set.
 */
export function registerWorkflowPanes(registry: PaneRegistry): void {
  for (const descriptor of WORKFLOW_PANES) {
    registry.register(descriptor);
  }
}
