// Where the console's view families are composed in, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL
//
// Seven surface families (T-023p-1C-2 … T-023p-1C-8) are built on branches that
// run at the same time. Each has to become reachable from the entry point, and
// there is exactly one way to do that without every branch editing the same
// registry: give each family a SEAT — one line, reserved in advance, that only
// that family replaces. Six branches then produce six one-line diffs at six
// distinct positions and none of them conflicts.
//
// WHAT A FAMILY DOES
//
// A family exports `register<Family>(registry: ConsoleSurfaceRegistry): void` from
// its own `index.ts`, claims its slots inside that function, and replaces its own
// placeholder line below with the import and the call. That is the whole contract.
//
// WHAT A FAMILY DOES NOT DO
//
// A family never edits `frame/surface-registry.ts`, `bridge/scenario-manifest.ts`,
// `bridge/growth-slate.ts`, or `vitest.config.ts`. Those are shared spines: a
// six-way concurrent edit to any of them is a guaranteed conflict, and worse, a
// merge that resolves cleanly while silently dropping one family's registration.
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
import type { ConsoleSurfaceRegistry } from "./frame/surface-registry.js";
import { registerConsolePanes } from "./panes/index.js";
import { registerWorkflowSurfaces } from "./workflows/index.js";
import { consolePaneRegistry } from "./workspace/index.js";

/**
 * Register every shipped view family against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton so a test
 * can compose the same families into a registry it owns, and so an auxiliary
 * window can compose a different subset without a second code path.
 */
export function registerConsoleFamilies(registry: ConsoleSurfaceRegistry): void {
  // The three shipped Tier-1 families come first, because they were mounted
  // before any of the seats below existed. A family filling a seat that one of
  // them currently holds REPLACES it — delete that line, do not add beside it.
  // The registry refuses a second owner on one slot rather than letting import
  // order decide which surface mounts, so a seat added without the deletion is a
  // conflict the composition test names by slot rather than a silent swap.
  registerLegacySurfaces(registry);
  // The deck's pane bodies have their own seat board, keyed by pane kind
  // rather than by surface slot. It is composed here so one call reaches the
  // whole console, and it takes the module-scope pane registry because the
  // pane table is not the surface table this function was handed.
  registerConsolePanes(consolePaneRegistry);
  // T-023p-1C-2 ledger
  // T-023p-1C-3 composer
  // T-023p-1C-4 collaboration
  // T-023p-1C-5 repos
  registerWorkflowSurfaces(registry);
  // T-023p-1C-7 browser-terminal
  // T-023p-1C-8 gallery
}
