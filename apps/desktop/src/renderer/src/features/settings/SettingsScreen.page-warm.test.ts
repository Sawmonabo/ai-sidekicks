// When the settings screen's deferred pages are fetched: after the first frame, before anyone
// has chosen a section.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

// Deeply, as every consumer of a `.test-support` module does: a helper that exists for
// suites belongs to the module beside it and not on the feature's public entry.
import { ManualIdleWarmScheduler } from "@test/helpers/idle-warm.js";
import { renderSettingsScreen, windowAt } from "./SettingsScreen.test-support.js";
import { SettingsPageRegistry } from "./settings-pages.js";
import type { SettingsPageContext } from "./types.js";

/** Which sections a board asked for. */
interface DeferredPageProbe {
  readonly pages: SettingsPageRegistry;
  readonly loadedSections: string[];
}

/** One deferred page beside one component-form page. */
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
    // The board's lifetime begins when this destination opens, and choosing a section is a
    // second act after that — so the interval a person spends reading the rail is the one a
    // deferred page's chunk is charged to.
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
    // Without this, the case above would pass over a registry that warmed itself on
    // registration.
    const probe = deferredPageProbe();

    idleScheduler.runToQuiescence();

    expect(probe.loadedSections).toStrictEqual([]);
    expect(probe.pages.unloadedKeys()).toStrictEqual(["notifications"]);
  });
});
