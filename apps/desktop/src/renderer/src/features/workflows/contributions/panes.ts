// The workflows feature's pane kinds, `workflow-run` and `workflow-builder`.

import {
  type ConsolePaneRegistration,
  type ConsolePaneRegistry,
} from "@renderer/console/seats/index.js";

/**
 * The feature's owner string, as the pane and screen registries' duplicate policy reads it.
 *
 * One binding rather than two literals: the registry's policy is owner-scoped, so a
 * hot reload re-registering under the same owner replaces and a DIFFERENT owner
 * claiming a taken kind raises. Two literals that drifted by a character would make
 * the second registration a conflict with the first — a failure that reads as a seat
 * collision between families when it is one typo inside one.
 */
export const WORKFLOWS_OWNER = "workflows";

/**
 * Both pane kinds this family claims.
 *
 * THE NARROWING AND ITS REFUSAL ARE THE SEAT'S, NOT THIS FAMILY'S. The registry hands
 * every body the whole context union and only one arm is each pane's; the mismatched
 * arm is unreachable through the deck and is rendered rather than thrown anyway,
 * because `core/refusal.ts`' rule is that a boundary refuses by name and leaves the
 * surface standing. Six families answering that once each is six sentences for one
 * case, which is what `paneBodyForKind` exists to prevent — applied by each body module
 * this table names rather than here, since a loader-form registration carries a
 * specifier and not a render.
 */
const WORKFLOW_PANES: readonly ConsolePaneRegistration[] = [
  {
    kind: "workflow-run",
    owner: WORKFLOWS_OWNER,
    // A LOADER, like the builder below it: a run pane opens from the destination's run
    // list or from a run address, so nothing paints it before a person asks.
    //
    // The operator controls' class has one owner — this family's block is
    // `meridian-workflow-run-controls` — so no bundle boundary decides how the pane
    // looks. The module-shape rule in `apps/desktop/AGENTS.md` keeps a collision from
    // landing unnoticed, and review is what reads it.
    body: () => import("../run-page/run-page-body.js"),
  },
  {
    kind: "workflow-builder",
    owner: WORKFLOWS_OWNER,
    // The builder carries its own sheet, which no other family declares against, so
    // its body travels as its own chunk: the rail's destination opens it and nothing
    // paints it before a person asks.
    body: () => import("../builder/builder-pane-body.js"),
  },
];

/**
 * Claim this family's pane kinds against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerFeatureContributions`' reason: a test composes the same bodies into a registry it
 * owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowPanes(registry: ConsolePaneRegistry): void {
  for (const descriptor of WORKFLOW_PANES) {
    registry.register(descriptor);
  }
}
