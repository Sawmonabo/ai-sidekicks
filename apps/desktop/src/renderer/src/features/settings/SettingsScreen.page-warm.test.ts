// When the settings screen's deferred pages are fetched: at idle after mount, before a section
// is chosen.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

// Deep import, as every `.test-support` consumer does.
import { ManualIdleWarmScheduler } from "@test/helpers/idle-warm.js";
import { renderSettingsScreen, windowAt } from "./SettingsScreen.test-support.js";
import { SettingsPageRegistry } from "./settings-pages.js";
import type { SettingsPageContext } from "./types.js";

/** Which sections the registry's deferred loaders were asked for. */
interface DeferredPageProbe {
  readonly pages: SettingsPageRegistry;
  readonly loadedSections: string[];
}

/** A registry with one deferred page and one component-form page. */
function deferredPageProbe(): DeferredPageProbe {
  const loadedSections: string[] = [];
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "notifications",
    owner: "settings-screen-warm-test",
    label: "Notifications",
    keywords: [],
    body: () => {
      loadedSections.push("notifications");
      return Promise.resolve<{ Body: (context: SettingsPageContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  pages.register({
    section: "keyboard",
    owner: "settings-screen-warm-test",
    label: "Keyboard",
    keywords: [],
    render: () => null,
  });
  return { pages, loadedSections };
}

describe("the settings mount's idle walk", () => {
  let idleScheduler: ManualIdleWarmScheduler;

  beforeEach(() => {
    idleScheduler = new ManualIdleWarmScheduler();
    vi.stubGlobal("requestIdleCallback", idleScheduler.schedule);
    vi.stubGlobal("cancelIdleCallback", idleScheduler.cancel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms the board before anyone has chosen a section", async () => {
    // Choosing a section is a second act after mount, so the idle warm is what pays for a
    // deferred page's chunk.
    const settingsWindow = windowAt(undefined);
    const probe = deferredPageProbe();
    await renderSettingsScreen(settingsWindow.context, probe.pages);

    expect(idleScheduler.pendingCount).toBe(1);
    idleScheduler.runToQuiescence();

    expect(probe.loadedSections).toStrictEqual(["notifications"]);
    expect(probe.pages.unloadedKeys()).toStrictEqual([]);
    // A warm is not an open: nothing navigated.
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: undefined,
    });
  });

  it("negative control: a board no settings screen mounted over stays cold", () => {
    // Guards the case above against a registry that warms itself on registration.
    const probe = deferredPageProbe();

    idleScheduler.runToQuiescence();

    expect(probe.loadedSections).toStrictEqual([]);
    expect(probe.pages.unloadedKeys()).toStrictEqual(["notifications"]);
  });
});
