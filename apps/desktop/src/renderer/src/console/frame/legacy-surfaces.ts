// Which shipped Tier-1 renderer family holds which console slot.
//
// Three families shipped before the console existed and were rendered by the
// renderer root directly: the session probe, the participant roster, and the
// runtime-node roster. When the console took over the root they stopped being
// rendered by anything, which is not a decision anybody made — it is what happens
// when a new mount point lands before the old surfaces are re-homed.
//
// THE MOUNTS ARE `seats/absorbed-surfaces.ts` AND THE TABLE IS HERE. That module's
// header says why it had to leave: those mounts are moving inside console-authored
// surfaces as those land, the surfaces are view families, and a view family can reach
// `frame/` by no path — a deep import is refused, and the frame's door closes a cycle
// back through `families.ts`. A table of slots is the other half, and it is the
// frame's own vocabulary: a slot is an address the frame resolves, an owner is who
// answers at it, and the registry is the frame's.
//
// WHY THIS IS A `.ts` MODULE THAT BUILDS ELEMENTS RATHER THAN A COMPONENT FILE. It
// owns a TABLE — slot, owner, and what mounts there — not a view. Written as a `.tsx`
// it would be one file holding anonymous components, which is the shape the
// file-naming rule exists to prevent.

import { createElement, type ReactNode } from "react";

import { routeSessionId } from "../routing/index.js";
import {
  renderAbsorbedNodeRoster,
  renderAbsorbedParticipantRoster,
  renderAbsorbedSessionProbe,
  type ConsoleSurfaceDescriptor,
  type ConsoleSurfaceRegistry,
} from "../seats/index.js";
import { SessionsSurface } from "./SessionsSurface.js";

/**
 * The three shipped families, and the slot each holds.
 *
 * `sessions` and `workspace` are the destinations that name these surfaces; the
 * runtime-node roster takes the `agent-console` auxiliary window because it is about
 * the machines a session's agents run on, and because that slot's route grammar is
 * the only remaining one that GUARANTEES the session id the roster requires — the
 * frame resolves a bare auxiliary route through its context picker before any surface
 * renders, so the mount needs no invented empty state.
 *
 * The `sessions` row is the one that does not mount its component OUTRIGHT. The
 * session probe creates a session from its mount effect, and a route lifecycle
 * remounts a slot on every visit, so mounting it here would make navigating back to
 * the sessions list create a session. `SessionsSurface` holds the slot and builds the
 * probe on the participant's own act; the guard the seats door supplies still decides
 * WHAT that act builds, so the bridge-source rule stays written once.
 *
 * The components each family exports beyond these three take inputs no route carries
 * — an invite token, an attach draft — so a route cannot supply them and a slot for
 * them would be a slot nothing could ever fill.
 */
const LEGACY_SURFACES: readonly ConsoleSurfaceDescriptor[] = [
  {
    slot: "sessions",
    owner: "session-bootstrap",
    render: (context): ReactNode =>
      createElement(SessionsSurface, {
        frameStore: context.frameStore,
        sessionStoreRegistry: context.sessionStoreRegistry,
        // The port comes off the surface context's bridge rather than out of React
        // context, so the surface stays a function of what it is handed and its
        // tests need no provider to render it.
        growth: context.bridge.growth,
        startSession: () => renderAbsorbedSessionProbe(context.bridge.source),
      }),
  },
  {
    slot: "workspace",
    owner: "session-members",
    render: (context): ReactNode =>
      renderAbsorbedParticipantRoster(context.bridge.source, routeSessionId(context.route)),
  },
  {
    slot: "agent-console",
    owner: "runtime-node-attach",
    render: (context): ReactNode =>
      renderAbsorbedNodeRoster(context.bridge.source, routeSessionId(context.route)),
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
