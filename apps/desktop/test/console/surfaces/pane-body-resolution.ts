// How every tier that mounts a pane body gets one: preload, then resolve.
//
// ONE HOME BECAUSE THE WAIT IS ONE CLAIM. Four family mount modules resolved a body out
// of a registry with the same four lines, and when pane bodies became loader-backed all
// four needed the same new line in front of them — which is the shape
// `apps/desktop/AGENTS.md` §Shared code names: a helper used by two modules is hoisted
// on the second use. A per-module copy is also how a tier ends up with three mounts that
// await the body and a fourth that races it, and a screenshot taken against a body that
// had not arrived is stable, green, and a picture of the wrong thing.
//
// PRELOAD RATHER THAN A WIDER SETTLE. A loader-backed registration hands back a
// component that renders the pending fallback until its module lands, and the module
// lands on a dynamic import — which under Vitest needs more than the one macrotask a
// render settle crosses. `preload` is the registration's OWN loader, memoised, so
// awaiting it is exact rather than generous: a statically registered kind has nothing to
// load and settles immediately, and a loader-backed one is resolved before the first
// render rather than one frame into it.

import type { ReactNode } from "react";

import {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  type ConsolePaneContext,
  type ConsoleSurfaceContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";
// The LEAF for this one name: `ConsoleSurfaceSlot` is deliberately off the seats door,
// which that door's own header states — no production module reaches it through one, and
// the barrel census fails a line like that.
import { type ConsoleSurfaceSlot } from "../../../src/renderer/src/console/seats/surface-registry.js";

/**
 * The body the deck holds for a kind, with its module already loaded.
 *
 * TAKES THE FAMILY'S OWN REGISTRAR AND BUILDS THE REGISTRY HERE, for the reason each
 * caller used to state separately: the registry is owner-scoped state, so two tiers
 * sharing one instance would make the second tier's mount depend on whether the first
 * had run. One registrar rather than every family's, so a mount composes exactly the
 * body it captures.
 *
 * A throw rather than an optional return, so a family that stopped registering its kind
 * fails here — where the message names the kind — instead of rendering nothing and
 * letting a tier compare an empty box against a reference.
 *
 * The descriptor's `render` is handed back for React to MOUNT rather than called: bodies
 * hold hooks, and a plain call outside a render would run them against no dispatcher.
 */
export async function resolvedPaneBody(
  kind: PaneKind,
  registerPane: (registry: ConsolePaneRegistry) => void,
): Promise<(context: ConsolePaneContext) => ReactNode> {
  const registry = new ConsolePaneRegistry();
  registerPane(registry);
  await registry.preload(kind);
  const descriptor = registry.descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no console pane is registered for the \`${kind}\` kind`);
  }
  return descriptor.render;
}

/**
 * The body the frame holds for a surface slot, with its module already loaded.
 *
 * The pane helper's shape on the other board, and it earns its own function rather than
 * a generic over both: the two boards key on different unions, and a signature abstract
 * enough to take either would take a slot for a kind. What is shared is the RULE — build
 * a scoped registry, preload, resolve, throw by name — and the rule is what a reader
 * needs to see in both places.
 *
 * The preload matters here for a reason the pane path does not have: a route commits
 * before anything is mounted, so a deferred surface's reserved region is the WHOLE
 * window rather than one pane inside a settled frame.
 */
export async function resolvedSurfaceBody(
  slot: ConsoleSurfaceSlot,
  registerSurface: (registry: ConsoleSurfaceRegistry) => void,
): Promise<(context: ConsoleSurfaceContext) => ReactNode> {
  const registry = new ConsoleSurfaceRegistry();
  registerSurface(registry);
  await registry.preload(slot);
  const descriptor = registry.descriptorFor(slot);
  if (descriptor === undefined) {
    throw new Error(`no console surface is registered for the \`${slot}\` slot`);
  }
  return descriptor.render;
}
