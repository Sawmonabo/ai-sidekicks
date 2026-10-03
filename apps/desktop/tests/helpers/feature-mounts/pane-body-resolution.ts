// How every tier that mounts a pane body gets one: preload, then resolve.
//
// One home because the wait is one claim: pane bodies are loader-backed, and a per-module copy is
// how a tier ends up with mounts that await the body and one that races it, and a screenshot of a
// body that had not arrived is stable, green, and a picture of the wrong thing.
//
// Preload rather than a wider settle. A loader-backed registration renders the pending fallback
// until its module lands on a dynamic import, which under Vitest takes more than the one
// macrotask a render settle crosses. `preload` is the registration's own memoized loader, so
// awaiting it is exact: a statically registered kind settles immediately.

import type { ReactNode } from "react";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry, type ScreenName } from "@renderer/registries/screens/screen-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";

/**
 * The body the pane layout holds for a kind, with its module already loaded.
 *
 * Takes the feature's own registrar and builds the registry here: the registry is owner-scoped
 * state, so two tiers sharing one would make the second's mount depend on whether the first had
 * run, and a mount composes exactly the body it captures. Throws if the kind is unregistered, so
 * a tier never compares an empty box against a reference. `render` is returned for React to mount
 * rather than called, since bodies hold hooks.
 */
export async function resolvedPaneBody(
  kind: PaneKind,
  registerPane: (registry: PaneRegistry) => void,
): Promise<(context: PaneContext) => ReactNode> {
  const registry = new PaneRegistry();
  registerPane(registry);
  await registry.preload(kind);
  const descriptor = registry.descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no pane is registered for the \`${kind}\` kind`);
  }
  return descriptor.render;
}

/**
 * The body the frame holds for a screen name, with its module already loaded.
 *
 * The pane helper's shape on the other board; the two key on different unions, and a signature
 * abstract enough to take either would take a screen name for a kind. Preload matters more here:
 * a route commits before anything is mounted, so a deferred screen's reserved region is the whole
 * window.
 */
export async function resolvedScreenBody(
  screenName: ScreenName,
  registerScreens: (registry: ScreenRegistry) => void,
): Promise<(context: ScreenContext) => ReactNode> {
  const registry = new ScreenRegistry();
  registerScreens(registry);
  await registry.preload(screenName);
  const descriptor = registry.descriptorFor(screenName);
  if (descriptor === undefined) {
    throw new Error(`no screen is registered under the \`${screenName}\` name`);
  }
  return descriptor.render;
}
