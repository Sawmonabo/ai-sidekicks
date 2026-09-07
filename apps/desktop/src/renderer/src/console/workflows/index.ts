// The workflows family's door.
//
// The family is the workflows destination's own surface — the definitions browser
// — plus the two pane kinds `Spec-023 §Console Design (Meridian)` reserves for it,
// `workflow-run` and `workflow-builder`. Both pane BODIES live under `./pane/`,
// inside the family that owns them: `console/panes/` is the deck's composition site
// and holds composition files only, so a body there would be one directory's while
// the vocabulary it is built from was another's. Each body has its own sub-module
// door, reached from here by a deep intra-family specifier.
//
// WHAT LEAVES THE FAMILY IS TWO REGISTRATIONS AND NOTHING ELSE. Not the surface,
// not the panes, not the chrome: the console composes this family by calling
// `registerWorkflowPanes` at its pane seat and `registerWorkflowSurfaces` at its
// surface seat, and nothing above needs a handle on a body. An export beyond those
// would be an invitation for another family to mount a workflows surface itself,
// which is the coupling the deck's and the frame's single mount doors exist to
// prevent.
//
// TWO SEATS BECAUSE THERE ARE TWO BOARDS. The deck's board is keyed by pane kind
// and the frame's by surface slot; this family occupies one seat on each — the two
// pane kinds it claims, and the rail destination the spec's surface set gives it.
// Until the surface seat was filled, pressing the rail's middle destination reached
// the frame's reserved-slot absence, which was a true sentence about a browser this
// family had in fact already built.
//
// THE FAMILY'S SHARED SHEET IS NOT IMPORTED HERE ANY MORE. All three of this family's
// bodies arrive behind a loader now, so nothing statically reachable from this module can
// render against `workflows.css` — and a door sheet no reader on the door's own graph can
// use is charged to every session and painted for none of them. Each of the three chunk
// roots imports it instead, which is the rule `apps/desktop/AGENTS.md` states from the
// other side: the stylesheets a lazily-loaded directory owns enter through that chunk's
// root.
//
// ONE SHEET STAYS, AND IT IS NOT THIS FAMILY'S CHROME. `runs/run-list.css` declares
// `.meridian-run-row__failure` and so does `runs/pane/runs.css` — two families, one class
// name, different declarations — so which of the two the browser sees LAST decides how a
// failed run's line reads in both. Deferring this one would make that answer depend on
// whether a workflows chunk had happened to load, which is a bundle boundary deciding how
// another family's surface looks. It stays on the initial document until that collision is
// settled the way the run-controls one was, by giving the class one owner and regenerating
// the references that show it.
//
// WHY THIS BARREL IS A `.ts` AND NOT A `.tsx`. It owns a TABLE — kind, owner, and the
// specifier each body arrives behind — not a view. Written as a component file it would
// be a `.tsx` holding no component at all.

import "./runs/run-list.css";

// BOTH SEATS ARE ONE ORDINARY DOOR NOW. Both boards were authored in `frame/`, which
// a view family cannot import at all — that door re-exports `ConsoleRoot`, which
// composes `families.ts`, which composes this family — so the registrations were taken
// by a deep specifier the layering config subtracted at the `to` end by name. The
// substrate hoisted both boards down to `seats/`, which sits below every view family,
// so this is one edge through one door and the config carries no exemption for it.
import {
  type ConsolePaneRegistration,
  type ConsolePaneRegistry,
  type ConsoleSurfaceRegistry,
} from "../seats/index.js";

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
 * NO TEAR-OFF ANSWER TRAVELS WITH THEM, deliberately: whether a kind may be torn off
 * into an auxiliary window is `seats/pane-kinds.ts`'s `isDetachablePaneKind`, derived
 * from the window model's own closed set. `Spec-023 §Console Design (Meridian)` ships
 * exactly two auxiliary windows, `timeline` and `agent-console`, and neither of these
 * is one — but a boolean stated here would be asked of each descriptor independently,
 * so a kind could advertise a detach path the window model cannot serve and neither
 * this registration nor the type system would notice.
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
    // either surface looks. `test/console/architecture/stylesheet-selector-owners.test.ts`
    // holds the census that keeps a second collision from landing unnoticed.
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

/**
 * Claim the rail's workflows destination against a registry.
 *
 * Takes the registry rather than the module-scope singleton, for
 * `registerWorkflowPanes`' reason: a test composes the same surface into a registry
 * it owns, and an auxiliary window composes a different subset without a second code
 * path.
 *
 * The descriptor is built here rather than kept in a table beside the pane
 * descriptors: there is exactly one of it, and a one-row table is a shape that
 * invites a second row nobody decided to add.
 */
export function registerWorkflowSurfaces(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "workflows",
    owner: WORKFLOWS_OWNER,
    // A LOADER, and the seat's reasoning about WHICH component to mount moved with it
    // to `workflows-surface-body.ts`. `#/workflows` is a rail destination — nothing
    // paints it until a person asks — so registering it with a `render` put the host,
    // the scope picker, the definitions browser and the run list on every session's
    // initial graph and left `preload("workflows")` with nothing to fetch.
    body: () => import("./workflows-surface-body.js"),
  });
}
