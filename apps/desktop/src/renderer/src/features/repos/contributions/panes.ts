// The pane kind the repos feature claims: the diff pane.

import type { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { REPOS_FEATURE_OWNER } from "./owner.js";

/**
 * Claim the `diff` pane kind.
 *
 * Takes the registry rather than reaching for the module-scope singleton, so a test
 * composes the same body into a registry it owns. The kind declares no tear-off: whether
 * a pane may be torn off is a property of the kind, answered once by
 * `isDetachablePaneKind`.
 */
export function registerReposPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "diff",
    owner: REPOS_FEATURE_OWNER,
    // Loader-backed: the pane is not on the first paint, and it reaches the diff parser
    // and the virtualized row renderer, the largest block this feature would put on the
    // initial import graph.
    body: () => import("./diff-pane-body.js"),
  });
}
