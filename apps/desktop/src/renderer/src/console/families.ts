// Where the console's view families are composed in, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL
//
// Seven surface families are built on branches that run at the same time. Each has to
// become reachable from the entry point, and there is exactly one way to do that
// without every branch editing the same registry: give each family a SEAT — one line,
// reserved in advance, that only that family replaces. Each branch then produces one
// one-line diff at a position no other branch touches, and none of them conflicts.
//
// SEVEN IS THE ONLY COUNT THIS HEADER STATES, and it is the number of reserved seat
// lines at the foot of the composition. It was not always: this header spelled the
// count twice and the spellings disagreed, because 1C-8 was read as an audit task
// when it lands a family of its own. A second spelling of one count is a second thing
// to edit, and the one that goes stale is the one nothing reads.
//
// WHAT A FAMILY DOES
//
// A family exports `register<Family>(registry: ConsoleSurfaceRegistry): void` from
// its own `index.ts`, claims its slots inside that function, and replaces its own
// placeholder line below with the import and the call. That is the whole contract.
//
// WHAT A FAMILY DOES NOT DO
//
// A family never edits `seats/surface/surface-registry.ts`, `bridge/scenario/manifest.ts`,
// or `vitest.config.ts`. Those are shared spines: a
// concurrent edit to any of them from every one of those branches at once is a
// guaranteed conflict, and worse, a merge that resolves cleanly while silently
// dropping one family's registration.
// A family registers through its own `index.ts` and its own reserved lines — here,
// and in `bridge/scenario/corpus.ts` for its fixture scenario.
//
// ORDER IS THE DAG, NOT PREFERENCE
//
// Calls run in family order, low to high, matching the import DAG the families
// themselves obey. A family that needed to run before another to work would be
// telling us it has a dependency it has not declared.
//
// COMPOSITION ONLY
//
// No logic lands here. If this file ever needs a condition, a try, or a value of
// its own, the thing it is deciding belongs in the family that owns the decision.

import { registerSessionSurfacesFamily } from "./session-surfaces-family.js";
import { registerComposerFamily } from "@renderer/features/composer/contributions/composer-view.js";
import { registerComposerInlineCards } from "@renderer/features/composer/contributions/inline-cards.js";
import { registerPaneHarnessSurface } from "./frame/pane-harness/PaneHarnessSurface.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "@renderer/store/session-events/run-lifecycle-projector.js";
import {
  APPROVAL_FLOW_PROJECTOR_OWNER,
  APPROVAL_FLOW_PROJECTORS,
} from "@renderer/store/session-events/approval-flow-projection.js";
import { registerLedger } from "@renderer/features/transcript/contributions/screens.js";
import { registerConsolePanes } from "./panes/index.js";
import { registerRepos } from "@renderer/features/repos/contributions/inline-cards.js";
import { registerInspectorInlineCards } from "@renderer/features/inspector/contributions/inline-cards.js";
import { Workspace } from "@renderer/features/sessions/SessionScreen.js";
import type { ConsoleEntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import type {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  InlineCardSeatRegistry,
} from "./seats/index.js";
import { registerWorkflowSurfaces } from "@renderer/features/workflows/index.js";

/**
 * Register every shipped view family against the four boards a composition owns.
 *
 * ALL FOUR ARE PARAMETERS, and none is defaulted to a singleton: a default is the same
 * hard-coding one parameter along, since a caller that forgets it still writes into
 * production. Taking the surface, pane, projector and inline-card boards here is what
 * lets a test compose into boards it owns.
 */
export function registerConsoleFamilies(
  surfaces: ConsoleSurfaceRegistry,
  panes: ConsolePaneRegistry,
  projectors: ConsoleEntityProjectorRegistry,
  inlineCardSeats: InlineCardSeatRegistry,
): void {
  // NO PRE-CONSOLE FAMILY CLAIMS A SLOT OF ITS OWN ANY MORE. Two of them are
  // absorbed by the console surfaces that mount them, through the helpers
  // `seats/surface/absorbed-surfaces.ts` publishes, so they reach the screen inside a
  // console-authored surface rather than beside one. The shipped user roster
  // was the last slot claimant, and it is retired rather than re-homed: it rendered
  // presence a second time in one application, and the channels family renders
  // presence from the bridge the console resolved. The `workspace` slot it used to
  // hold is the LEDGER's now, claimed at that family's own seat below, so the frame
  // resolves a console-authored body there rather than a reservation.
  //
  // The deck's pane bodies have their own seat board, keyed by pane kind
  // rather than by surface slot. It is composed here so one call reaches the
  // whole console, and it takes the pane registry this function was HANDED —
  // the pane table is not the surface table, and it is not the caller's
  // business twice over which of the two a composition is allowed to own.
  registerConsolePanes(panes);
  // The frame's own projector claim, on the same terms as any family's. It is a
  // registration and not a constant handed downstream, because the fold a store is
  // opened with is what decides which family can own which partition — and it takes
  // the projector board this function was HANDED, so a composition writes its fold
  // where it writes its surfaces and its panes.
  projectors.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
  // The approval-flow fold, whose entities the approval card reads. Without it the
  // `approval` partition has no producer at all.
  projectors.registerAll(APPROVAL_FLOW_PROJECTORS, APPROVAL_FLOW_PROJECTOR_OWNER);
  // The fixture-only pane harness, which is the one surface that mounts a
  // REGISTERED pane body in a running window. It takes both boards because it
  // resolves its body out of the pane board this composition owns, and it decides
  // for itself — behind `__SIDEKICKS_CONSOLE_FIXTURES__`, inside its own module —
  // whether it registers at all, so no condition lands here. It is composed after
  // `registerConsolePanes` because that is the family order; resolution happens at
  // render, so the order is legibility rather than a dependency.
  registerPaneHarnessSurface(surfaces, panes);
  // The browser-terminal family has landed and claims no surface slot: both of its
  // kinds are pane bodies, registered through `registerBrowserPanes` and
  // `registerTerminalPanes` on the pane board in `panes/index.ts`, so it has nothing
  // to call at its seat. Said out loud because a reservation and a deliberate absence
  // read identically, and the difference is the whole question a reader arrives with.
  // The seat line itself stays in its reserved shape, which is the shape it would
  // take either way — a seat is a seat filled or not, and the board counts it. Said
  // HERE rather than beside that line, because the block below holds seats only.
  // Each seat below receives the boards it writes into, out of the four this
  // composition was handed. A family claims a surface slot, a pane kind, the event
  // kinds whose fold it owns, or an inline-card body — through its own
  // `register<Family>` entry point, never by editing a shared spine and never through
  // a board's module-scope registrar, which writes into production whatever the
  // caller composed into.
  //
  // A seat may also be handed a COMPOSITION argument beside its boards: one view family
  // may not import another, so this root — the one file allowed to name more than one —
  // says which component a family's slot mounts. It is NAMED here rather than written
  // into the seat, because a seat line passes identifiers and nothing else, which is
  // what keeps the block a grammar a reviewer can read at a glance.
  const ledgerComposition = { workspace: Workspace };
  //
  // NOTHING BUT SEATS BELOW THIS LINE. A paragraph between two seats reads to a
  // branch exactly like this one does above them, and only one of the two leaves
  // seven one-line diffs at seven distinct positions.
  registerLedger(surfaces, ledgerComposition); // ledger
  registerComposerFamily(); // composer
  registerComposerInlineCards(inlineCardSeats); // composer
  registerSessionSurfacesFamily(surfaces); // session surfaces
  registerRepos(inlineCardSeats); // repos
  registerInspectorInlineCards(inlineCardSeats); // inspector
  registerWorkflowSurfaces(surfaces); // workflows
  // browser-terminal
  // gallery
}
