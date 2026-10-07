// What the rail shows and where each destination goes: the one place `NavigationRail` (which
// knows no routes) and `routing/` (which knows no rail) meet. Every destination is reachable from
// every main-window route, so the entries are constants. A session screen route maps onto
// `sessions`. Render order comes from the `RAIL_DESTINATIONS` tuple, the set from the entry table;
// Settings, last in the tuple, stands apart at the rail's foot.

import { RAIL_DESTINATIONS, type RailDestination } from "#renderer/routing/readers.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import {
  findScreenNameForRoute,
  type ScreenRegistry,
} from "#renderer/registries/screens/registry.js";
import { preloadQuietly } from "#renderer/components/LazyBody/idle-warm.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./NavigationRail.js";

/**
 * The destinations above the rail's spacer, built once. A module constant, not a per-render
 * builder, so `AppFrame` is not handed a new array on every pass.
 */
export const RAIL_ENTRIES: readonly RailEntry[] = RAIL_DESTINATIONS.filter(
  (destination) => destination !== "settings",
).map((destination) => ({ destination, ...RAIL_ENTRY_TEMPLATES[destination] }));

/** The Settings destination, at the rail's foot below its controls. */
export const RAIL_SETTINGS_ENTRY: RailEntry = {
  destination: "settings",
  ...RAIL_ENTRY_TEMPLATES.settings,
};

/**
 * Where a rail click goes: Settings opens on `lastSettingsPageId`, the page last open, or on its
 * list before any was. Total; `railDestinationFor` is its inverse on every arm.
 */
export function routeForDestination(
  destination: RailDestination,
  lastSettingsPageId: SettingsPageId | undefined,
): AppRoute {
  switch (destination) {
    case "sessions":
      return { kind: "sessions" };
    case "sidekicks":
      return { kind: "sidekicks" };
    case "skills":
      return { kind: "skills" };
    case "workflows":
      return { kind: "workflows" };
    case "settings":
      return { kind: "settings", page: lastSettingsPageId };
  }
}

/**
 * Starts loading the screen a destination would mount, without navigating to it. The rail press and
 * the palette's highlighted row call it before the route commits, so the chunk is in flight or
 * loaded by the time the screen mounts. It does nothing for a component-form or unregistered
 * screen, and a failed load is dropped.
 */
export function warmDestination(
  screenRegistry: ScreenRegistry,
  destination: RailDestination,
): void {
  // Fire-and-forget: a speculative fetch has nobody waiting, and a chunk that will not load is
  // reported at the mount, where the error boundary can say so.
  // Any page of a destination mounts the same screen, so the warm names none.
  void warmRouteScreen(screenRegistry, routeForDestination(destination, undefined));
}

/**
 * Starts loading the screen a route would mount and settles when it has landed. Never rejects: a
 * chunk that will not load is a damaged install, reported at the mount and not at a warm nobody
 * watches. A component-form or unregistered screen settles immediately.
 */
async function warmRouteScreen(screenRegistry: ScreenRegistry, route: AppRoute): Promise<void> {
  const screenName = findScreenNameForRoute(route);
  if (screenName === undefined) {
    return;
  }
  await preloadQuietly(screenRegistry.preload(screenName));
}
