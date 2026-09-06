// Where the console's view families are composed in, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL
//
// Seven surface families (T-023p-1C-2 … T-023p-1C-8) are built on branches that run
// at the same time. Each has to become reachable from the entry point, and there is
// exactly one way to do that without every branch editing the same registry: give
// each family a SEAT — one line, reserved in advance, that only that family
// replaces. Each branch then produces one one-line diff at a position no other
// branch touches, and none of them conflicts.
//
// SEVEN IS THE ONLY COUNT THIS HEADER STATES, and it is the number of reserved seat
// lines at the foot of the composition — asserted by `families.test.ts` rather than
// kept in step by hand. It was not: this header spelled the count twice and the
// spellings disagreed, because 1C-8 was read as an audit task when it lands a family
// of its own. A second spelling of one count is a second thing to edit, and the one
// that goes stale is the one nothing reads.
//
// WHAT A FAMILY DOES
//
// A family exports `register<Family>(registry: ConsoleSurfaceRegistry): void` from
// its own `index.ts`, claims its slots inside that function, and replaces its own
// placeholder line below with the import and the call. That is the whole contract.
//
// WHAT A FAMILY DOES NOT DO
//
// A family never edits `frame/surface-registry.ts`, `bridge/scenario-runtime/scenario-manifest.ts`,
// `bridge/growth-port/growth-slate.ts`, or `vitest.config.ts`. Those are shared spines: a
// concurrent edit to any of them from every one of those branches at once is a
// guaranteed conflict, and worse, a merge that resolves cleanly while silently
// dropping one family's registration.
// A family registers through its own `index.ts` and its own reserved lines — here,
// and in `bridge/scenarios/index.ts` for its fixture scenario.
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

import { registerLegacySurfaces } from "./frame/legacy-surfaces.js";
import { registerRunLifecycleProjectors } from "./frame/run-lifecycle-projector.js";
import type { ConsoleSurfaceRegistry } from "./frame/surface-registry.js";
import { registerConsolePanes } from "./panes/index.js";
import type { ConsoleEntityProjectorRegistry } from "./store/index.js";
import type { ConsolePaneRegistry } from "./seats/index.js";

/**
 * Register every shipped view family against the three registries a composition owns.
 *
 * ALL THREE ARE PARAMETERS, and the second and third are this signature's whole
 * history. The surface registry was passed in from the start so a test could compose
 * into a registry it owns and an auxiliary window could compose a subset; the pane
 * board beside it reached for the module-scope singleton, so a caller composing its
 * own family set still registered panes into the production one. That is inert only
 * while every pane seat is still reserved — the moment the first family registers a
 * body, an independent composition mutates the running console's deck, two
 * compositions leak registrations into each other, and an auxiliary window cannot
 * select a different pane subset however carefully it asks.
 *
 * The projector board is the third for the same reason and a sharper one: the session
 * store's fold used to be a CONSTANT decided in the frame, so no family could project
 * its own event category into the partition it owns. A family that cannot do that
 * reads the wire twice — once through its own read and again through a subscription
 * it should not need — and keeps the result beside the store instead of in it. It is
 * a parameter here so a test and an auxiliary window compose their own fold, exactly
 * as they compose their own surfaces and panes.
 *
 * Required rather than defaulted to the singletons, because a default is the same
 * hard-coding one parameter along: a caller that forgets it still writes into
 * production. Naming all three at the one composition site is what makes a
 * composition legible as a whole.
 */
export function registerConsoleFamilies(
  registry: ConsoleSurfaceRegistry,
  paneRegistry: ConsolePaneRegistry,
  projectorRegistry: ConsoleEntityProjectorRegistry,
): void {
  // The three shipped Tier-1 families come first, because they were mounted
  // before any of the seats below existed. A family filling a seat that one of
  // them currently holds REPLACES it — delete that line, do not add beside it.
  // The registry refuses a second owner on one slot rather than letting import
  // order decide which surface mounts, so a seat added without the deletion is a
  // conflict the composition test names by slot rather than a silent swap.
  registerLegacySurfaces(registry);
  // The deck's pane bodies have their own seat board, keyed by pane kind
  // rather than by surface slot. It is composed here so one call reaches the
  // whole console, and it takes the pane registry this function was HANDED —
  // the pane table is not the surface table, and it is not the caller's
  // business twice over which of the two a composition is allowed to own.
  registerConsolePanes(paneRegistry);
  // The frame's own projector claim, on the same terms as any family's. It is a
  // registration and not a constant handed downstream, because the fold a store is
  // opened with is what decides which family can own which partition — and it takes
  // the projector board this function was HANDED, so a composition writes its fold
  // where it writes its surfaces and its panes.
  registerRunLifecycleProjectors(projectorRegistry);
  // Each seat below receives all three boards. A family claims a surface slot, a
  // pane kind, and the event kinds whose fold it owns — through its own
  // `register<Family>` entry point, never by editing a shared spine.
  // T-023p-1C-2 ledger
  // T-023p-1C-3 composer
  // T-023p-1C-4 collaboration
  // T-023p-1C-5 repos
  // T-023p-1C-6 workflows
  // T-023p-1C-7 browser-terminal
  // T-023p-1C-8 gallery
}
