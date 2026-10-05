// The pane kind the repos feature claims: the diff pane.

import type { PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { REPOS_FEATURE_OWNER } from "./owner.js";

/** Claim the `diff` pane kind in the given registry. */
export function registerReposPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "diff",
    owner: REPOS_FEATURE_OWNER,
    // Loader-backed: the diff parser and row renderer are the largest block this feature
    // would put on the first-paint import graph.
    body: () => import("./diff-pane-body.js"),
  });
}
