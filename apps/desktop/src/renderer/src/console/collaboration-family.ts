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

import {
  registerCollaborationProjectors,
  registerCollaborationSections,
} from "./collaboration/index.js";
import type { ConsoleEntityProjectorRegistry } from "./store/index.js";
import type { ConsoleSurfaceRegistry, SidebarSectionRegistry } from "./seats/index.js";
import { registerAgentConsoleSurface } from "./agents/index.js";
import { registerSessionsSurface } from "./sessions/index.js";
import { registerSettingsSurface } from "./settings/index.js";

/**
 * Claim every surface slot this family owns, fill the sidebar sections it fills, and
 * fold the one event category whose partition it reads.
 *
 * Three boards, because they are three different seats: a surface slot is a whole
 * destination the frame mounts, a sidebar section is a body inside a sidebar another
 * family owns, and a projector claim is one event kind's fold into the store every
 * family shares. All three are HANDED to this function rather than reached for.
 *
 * The projector board is the third and the newest, and it is what lets this family
 * read `membership.created` ONCE. Without it the roster, the typing indicators, the
 * direct-channel labels, and the membership ledger each had to reach the wire for a
 * fact the store already had in front of it — or, as they in fact did, render a raw
 * participant id and an absent membership identifier instead.
 * The sidebar board ships a module-scope singleton and the sections registrar used
 * to write straight into it, which is the one shape `registerConsoleFamilies` exists
 * to refuse: an independent composition would mutate the running console's sidebar,
 * two compositions would leak sections into each other, and an auxiliary window
 * could not compose a subset however it asked. A board a caller supplies has none of
 * those failures, and a test composing this family owns what it asserts against.
 */
export function registerCollaborationFamily(
  surfaces: ConsoleSurfaceRegistry,
  sidebarSections: SidebarSectionRegistry,
  projectors: ConsoleEntityProjectorRegistry,
): void {
  registerSessionsSurface(surfaces);
  registerSettingsSurface(surfaces);
  registerAgentConsoleSurface(surfaces);
  registerCollaborationSections(sidebarSections);
  registerCollaborationProjectors(projectors);
}
