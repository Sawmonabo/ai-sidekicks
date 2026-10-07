// Reopening Settings opens the page last open: the kept record routes the rail's Settings to it,
// and a record naming no page this app has opens the list instead.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { routeForDestination } from "#renderer/layout/NavigationRail/destinations.js";
import { LastSettingsPage } from "./last-settings-page.js";
import { MemoryPersistenceAdapter } from "./persistence/memory-adapter.js";
import { UiStateStore } from "./persistence/ui-state-store.js";

/** The page Settings reopens on after an app restart that found `kept` in the store. */
async function pageReopenedFrom(kept: Readonly<Record<string, string>>): Promise<unknown> {
  const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
  const before = new LastSettingsPage(uiStateStore);
  await before.hydrate();
  await uiStateStore.writeGlobal("settings-last-page", "selection", kept);
  before.dispose();

  const after = new LastSettingsPage(uiStateStore);
  await after.hydrate();
  const route = routeForDestination("settings", after.pageId);
  return route.kind === "settings" ? route.page : route.kind;
}

describe("the settings page last open", () => {
  it("is where Settings reopens, and a page this app no longer has opens the list", async () => {
    expect(await pageReopenedFrom({ page: "keyboard" })).toBe("keyboard");
    expect(await pageReopenedFrom({ page: "removed-page" })).toBeUndefined();
  });

  it("keeps the page recorded on this device across a restart", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    const before = new LastSettingsPage(uiStateStore);
    await before.hydrate();
    before.record("runtime");
    expect(before.pageId).toBe("runtime");
    // The write is the store's own; it has settled once the platform has run a task.
    await crossMacrotaskBoundary();

    const after = new LastSettingsPage(uiStateStore);
    await after.hydrate();
    expect(after.pageId).toBe("runtime");
  });
});
