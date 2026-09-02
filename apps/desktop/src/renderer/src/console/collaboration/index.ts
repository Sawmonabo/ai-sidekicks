// The collaboration family's door — the one line `console/families.ts` calls.
//
// WHAT THIS FAMILY IS
//
// Channels, the roster, invites, and members; the agent console; and the settings
// frame with its pages. Those live in four subtrees rather than one, because they
// are four different shapes — a rail destination, a settings frame, a pane body,
// and a set of sidebar sections — and a single directory holding all four would be
// a directory named after a task rather than after a thing.
//
// WHAT THIS FILE IS
//
// Composition, and nothing else. The seat board hands this family a registry; this
// file passes it to each subtree's own registrar in the order the console's DAG
// already puts them. No logic lands here: if it ever needs a condition, a `try`, or
// a value of its own, the thing it is deciding belongs in the subtree that owns the
// decision.
//
// A subtree never registers itself at module scope. The registrar takes the
// registry it is handed, for `registerConsoleFamilies`' reason: a test composes this
// family into a registry it owns, and an auxiliary window composes a subset without
// a second code path.

// THE FRAME IS REACHED BY MODULE AND NOT THROUGH ITS BARREL. `frame/index.ts`
// exports `ConsoleRoot`, which composes `console/families.ts`, which composes this
// family — so a view family importing that barrel closes a real import cycle, and
// the layering gate says so. `console/families.ts` reaches `frame/legacy-surfaces.js`
// the same way and for the same reason. The rule that cross-family imports go
// through a barrel holds everywhere the barrel is not itself the composition root.

import type { ConsoleSurfaceRegistry } from "../frame/surface-registry.js";
import { registerAgentConsoleSurface } from "../panes/agent-console/index.js";
import { registerSessionsSurface } from "../sessions/index.js";
import { registerSettingsSurface } from "../settings/index.js";

/** Claim every surface slot this family owns. */
export function registerCollaborationFamily(registry: ConsoleSurfaceRegistry): void {
  registerSessionsSurface(registry);
  registerSettingsSurface(registry);
  registerAgentConsoleSurface(registry);
}
