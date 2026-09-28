// The workflows family's door.
//
// The family is the workflows destination's own surface plus the two pane kinds the
// console reserves for it, `workflow-run` and `workflow-builder`. Both pane bodies live
// under `./pane/`; `console/panes/` is the deck's composition site and holds composition
// files only. What leaves the family is two registrations: the console calls
// `registerWorkflowPanes` at its pane seat and `registerWorkflowSurfaces` at its surface
// seat, and nothing above needs a handle on a body. The one other export is the
// definition row. Anything else would invite another family to mount a workflows surface
// itself, which the deck's and the frame's single mount doors exist to prevent.
//
// Every body arrives behind a loader, so nothing statically reachable from this module
// renders against `workflows.css`; the chunk roots that paint the family's chrome import
// it instead. This door imports `runs/run-list.css` and `parks/park-badge.css` itself, so
// they ride the initial document.

import "./runs/run-list.css";
import "./parks/park-badge.css";

import {
  type ConsolePaneRegistration,
  type ConsolePaneRegistry,
  type ConsoleSurfaceRegistration,
  type ConsoleSurfaceRegistry,
} from "../seats/index.js";

export {
  /** @consumedBy the Workflows tab's table of definitions */
  DefinitionListItem,
} from "./definitions/DefinitionListItem.js";

/**
 * The family's owner string, as the pane registry's duplicate policy reads it.
 *
 * One binding rather than two literals: the registry's policy is owner-scoped, so a
 * hot reload re-registering under the same owner replaces and a DIFFERENT owner
 * claiming a taken kind raises. Two literals that drifted by a character would make
 * the second registration a conflict with the first — a failure that reads as a seat
 * collision between families when it is one typo inside one.
 */
const WORKFLOWS_OWNER = "workflows";

/**
 * Both pane kinds this family claims.
 *
 * NO TEAR-OFF ANSWER TRAVELS WITH THEM, deliberately: whether a kind may be torn off into
 * an auxiliary window is `seats/pane/pane-kinds.ts`'s `isDetachablePaneKind`, derived
 * from the window model's own closed set. The console ships exactly two auxiliary
 * windows, `timeline` and `agent-console`, and neither of these is one — but a boolean
 * stated here would be asked of each descriptor independently, so a kind could advertise
 * a detach path the window model cannot serve and neither this registration nor the type
 * system would notice.
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
    // IT WAS A `render` FOR ONE ROUND, and the reason it no longer is belongs here rather
    // than in the body: `pane/run/run-controls.css` and `runs/pane/runs.css` both declared
    // `.meridian-run-controls` with different layout declarations and disjoint children,
    // so which sheet the browser saw LAST decided how this pane laid its operator controls
    // out — and deferring this body moved this family's sheet to the end of that cascade.
    // Keeping the body eager hid the coupling instead of removing it. The class has one
    // owner now: this family's block is `meridian-workflow-run-controls` and the runs
    // family keeps the name it was already declaring, so no bundle boundary decides how
    // either surface looks. The module-shape rule in `apps/desktop/AGENTS.md` keeps a
    // second collision from landing unnoticed, and review is what reads it.
    body: () => import("./pane/workflow-run-pane-body.js"),
  },
  {
    kind: "workflow-builder",
    owner: WORKFLOWS_OWNER,
    // The builder carries its own sheet, which no other family declares against, so
    // its body travels as its own chunk: the rail's destination opens it and nothing
    // paints it before a person asks.
    body: () => import("./pane/workflow-builder-pane-body.js"),
  },
];

/**
 * Claim this family's pane kinds against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes the same bodies into a registry it
 * owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowPanes(registry: ConsolePaneRegistry): void {
  for (const descriptor of WORKFLOW_PANES) {
    registry.register(descriptor);
  }
}

/** The surface slot this family claims: the rail's workflows destination. */
const WORKFLOW_SURFACES: readonly ConsoleSurfaceRegistration[] = [
  {
    slot: "workflows",
    owner: WORKFLOWS_OWNER,
    // A loader: the rail destination paints nothing until a person asks, and a `render`
    // here would put the host and the run list on every session's initial graph.
    body: () => import("./workflows-surface-body.js"),
  },
];

/**
 * Claim this family's surface slots against a registry.
 *
 * Takes the registry rather than the module-scope singleton, for
 * `registerWorkflowPanes`' reason: a test composes the same surfaces into a registry
 * it owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowSurfaces(registry: ConsoleSurfaceRegistry): void {
  for (const descriptor of WORKFLOW_SURFACES) {
    registry.register(descriptor);
  }
}
