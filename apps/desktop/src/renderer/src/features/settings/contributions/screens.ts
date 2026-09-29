import type { ScreenRegistry } from "@renderer/console/seats/index.js";

/**
 * Register the Settings screen.
 *
 * A loader rather than a render: nothing paints Settings until a person opens it, so its
 * pages and their stylesheets arrive in the chunk `settings-screen-body.ts` roots and stay
 * off the initial import graph.
 */
export function registerSettingsSurface(registry: ScreenRegistry): void {
  registry.register({
    slot: "settings",
    owner: "settings",
    body: () => import("../settings-screen-body.js"),
  });
}
