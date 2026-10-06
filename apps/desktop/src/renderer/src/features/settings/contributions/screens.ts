import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";

/**
 * Register the Settings screen.
 *
 * A loader rather than a render: nothing paints Settings until a person opens it, so its
 * pages and their stylesheets arrive in the chunk `features/settings/screen-body.ts` roots and stay
 * off the initial import graph.
 */
export function registerSettingsScreen(registry: ScreenRegistry): void {
  registry.register({
    name: "settings",
    owner: "settings",
    body: () => import("../screen-body.js"),
  });
}
