// Which shipped Tier-1 family holds which console slot — and, as of this merge, none
// of them does.
//
// Four families shipped before the console existed and were rendered by the renderer
// root directly. Every one of them now mounts inside a console-authored surface, and
// `seats/absorbed-surfaces.ts` holds those mounts — it had to, because the surfaces
// that mount them are four different view families and a view family cannot reach
// into the frame.
//
// THE TABLE IS EMPTY, AND THAT IS THE FINISHED STATE RATHER THAN A GAP. Each of the
// three slots this table used to hold was a placeholder for a console family that had
// not landed: `sessions` until the sessions family's list landed, `agent-console`
// until the agents family's console landed, and `workspace` until the ledger's
// workspace landed. All three have, each claims its slot through its own family door,
// and the registry refuses a second owner on one slot — so a row here would now be a
// composition conflict rather than a fallback.
//
// The registrar stays. It is called from `families.ts` beside the family seats, and a
// call that registers nothing is the honest shape for "no shipped family holds a slot
// of its own any more": deleting it would make the next Tier-1 surface that needs a
// temporary home reintroduce the concept rather than add a row.
//
// WHY THIS IS A `.ts` MODULE THAT BUILDS ELEMENTS RATHER THAN A COMPONENT FILE. It
// owns a TABLE — slot, owner, and what mounts there — not a view. Written as a `.tsx`
// it would be one file holding an anonymous component, which is the shape the
// file-naming rule exists to prevent.

import type { ConsoleSurfaceDescriptor, ConsoleSurfaceRegistry } from "../seats/index.js";

/**
 * The shipped families that still hold a slot of their own: none.
 *
 * The components each family exports take inputs no route carries — an invite token,
 * an attach draft — so a route cannot supply them and a slot for them would be a slot
 * nothing could ever fill. The invite acceptance view is exactly that case and is
 * mounted by its caller, which holds the token.
 */
const LEGACY_SURFACES: readonly ConsoleSurfaceDescriptor[] = [];

/**
 * Claim a slot for each shipped Tier-1 family.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for the
 * same reason `registerConsoleFamilies` does: composition is the caller's, so a test
 * can compose into a registry it owns and an auxiliary window can compose a subset
 * without a second code path.
 */
export function registerLegacySurfaces(registry: ConsoleSurfaceRegistry): void {
  for (const descriptor of LEGACY_SURFACES) {
    registry.register(descriptor);
  }
}
