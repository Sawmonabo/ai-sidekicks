// Where the collaboration family's four subtrees are composed in, and nothing else.
//
// WHY THIS SITS AT THE CONSOLE ROOT RATHER THAN IN `collaboration/`
//
// This family is four subtrees — the channels, roster, invites, and members
// sections; the all-sessions destination; the settings frame with its pages; and the
// agents family, whose agent console claims a surface slot of its own — because they
// are four different shapes and a single directory holding all four would be a
// directory named after a task rather than after a thing. Composing them means naming four view families in one file, and a view
// family may name no other: `console-view-family-isolation` in
// `.dependency-cruiser.mjs` fails that edge, because six concurrent family branches
// growing edges into each other is a tangle no ordering untangles.
//
// The gate subtracts the console's COMPOSITION SITES from both ends of that rule,
// and a file directly under `console/` is one — the same standing `families.ts` and
// `panes/index.ts` have. So the composition lives here, where naming four families
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

import { registerCollaborationSections } from "./collaboration/index.js";
import type { ConsoleSurfaceRegistry } from "./seats/index.js";
import { registerAgentConsoleSurface } from "./agents/index.js";
import { registerSessionsSurface } from "./sessions/index.js";
import { registerSettingsSurface } from "./settings/index.js";

/**
 * Claim every surface slot this family owns, and fill the sidebar sections it fills.
 *
 * Two registries, because they are two different seats: a surface slot is a whole
 * destination the frame mounts, and a sidebar section is a body inside a sidebar
 * another family owns. The sections registrar takes no argument because the sidebar
 * seat carries its own process-wide registry — the one place the console keeps a
 * registry a caller does not supply — so this file passes it nothing rather than
 * inventing a parameter to pass.
 */
export function registerCollaborationFamily(registry: ConsoleSurfaceRegistry): void {
  registerSessionsSurface(registry);
  registerSettingsSurface(registry);
  registerAgentConsoleSurface(registry);
  registerCollaborationSections();
}
