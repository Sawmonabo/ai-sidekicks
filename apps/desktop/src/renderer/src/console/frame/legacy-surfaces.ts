// Which shipped Tier-1 family holds which console slot.
//
// Four families shipped before the console existed and were rendered by the
// renderer root directly. Two of them now mount inside a console-authored surface,
// and `seats/absorbed-surfaces.ts` holds those mounts — it had to, because the
// surfaces that mount them are different view families and a view family cannot
// reach into the frame. A third holds a slot outright, below. The fourth is mounted
// by nothing at all.
//
// WHAT IS LEFT HERE IS THE TABLE, and a table of slots is the frame's own
// vocabulary: a slot is an address the frame resolves, an owner is who answers at
// it, and the registry is the frame's. The one family with no console-authored home
// yet still claims a slot outright, and it reaches its guarded mount through the
// seats door like every other consumer.
//
// WHY THIS IS A `.ts` MODULE THAT BUILDS ELEMENTS RATHER THAN A COMPONENT FILE. It
// owns a TABLE — slot, owner, and what mounts there — not a view. Written as a
// `.tsx` it would be one file holding an anonymous component, which is the shape the
// file-naming rule exists to prevent.

import type { ReactNode } from "react";

import { routeSessionId } from "../routing/index.js";
import {
  renderAbsorbedParticipantRoster,
  type ConsoleSurfaceDescriptor,
  type ConsoleSurfaceRegistry,
} from "../seats/index.js";

/**
 * The shipped family that still holds a slot of its own, and which slot.
 *
 * The participant roster takes `workspace` because that destination names it and
 * because no console-authored workspace surface has landed. Two of the others are
 * mounted by the console surfaces that absorbed them, through the helpers the seats
 * door publishes.
 *
 * The components each family exports beyond these take inputs no route carries — an
 * invite token, an attach draft — so a route cannot supply them and a slot for them
 * would be a slot nothing could ever fill. The invite acceptance view is exactly that
 * case, and it is now mounted by nobody: the deep-link lifecycle confines the token to
 * the main process, so there is no caller left that could hold one to hand it.
 */
const LEGACY_SURFACES: readonly ConsoleSurfaceDescriptor[] = [
  {
    slot: "workspace",
    owner: "session-members",
    render: (context): ReactNode =>
      renderAbsorbedParticipantRoster(context.bridge.source, routeSessionId(context.route)),
  },
];

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
