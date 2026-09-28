// Where the session-surfaces family's three subtrees are composed in, and nothing else.
//
// WHY THIS SITS AT THE CONSOLE ROOT RATHER THAN IN ONE OF THEM
//
// This family is three subtrees — the all-sessions destination; the settings frame
// with its pages; and the agents family, whose agent console claims a surface slot of
// its own — because they are three different shapes and a single directory holding all
// three would be a directory named after a task rather than after a thing. Composing
// them means naming three view families in one file, and a view family may name no
// other: `console-view-family-isolation` in
// `.dependency-cruiser.mjs` fails that edge, because six concurrent family branches
// growing edges into each other is a tangle no ordering untangles.
//
// The gate subtracts the console's COMPOSITION SITES from both ends of that rule,
// and a file directly under `console/` is one — the same standing `families.ts` and
// `panes/index.ts` have. So the composition lives here, where naming three families
// is what the file is for, and each subtree's own door names only itself.
//
// COMPOSITION ONLY
//
// No logic lands here. If this file ever needs a condition, a `try`, or a value of
// its own, the thing it is deciding belongs in the subtree that owns the decision.
//
// A subtree never registers itself at module scope. Each registrar takes the
// registry it is handed, for `registerConsoleFamilies`' reason: a test composes this
// family into a registry it owns, and an auxiliary window composes a subset without
// a second code path.

import type { ConsoleSurfaceRegistry } from "./seats/index.js";
import { registerAgentConsoleSurface } from "./agents/index.js";
import { registerSessionsSurface, type SessionsSurfaceComposition } from "./sessions/index.js";
import { registerSettingsSurface } from "./settings/index.js";

/**
 * Claim every surface slot this family owns.
 *
 * The surface board is HANDED to this function rather than reached for, for
 * `registerConsoleFamilies`' reason. The second argument is a COMPOSITION rather than a
 * board, on the terms `families.ts` names one under: the sessions destination offers a
 * composed draft beside the shipped probe, and that control is the workspace family's —
 * a view family this one may not import — so the root names which component fills the
 * place and this file hands it on.
 */
export function registerSessionSurfacesFamily(
  surfaces: ConsoleSurfaceRegistry,
  sessionsComposition: SessionsSurfaceComposition,
): void {
  registerSessionsSurface(surfaces, sessionsComposition);
  registerSettingsSurface(surfaces);
  registerAgentConsoleSurface(surfaces);
}
