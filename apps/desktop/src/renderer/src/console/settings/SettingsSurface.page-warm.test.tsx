// When this surface's deferred pages are fetched: on the way in, and before it.
//
// The defect these are the fix for was invisible to the type system and silent at run
// time. `SettingsPageRegistry.preload` had no production caller at all and this board took
// no idle walk, so a deferred page's import began when the pane rendered the route — and a
// person who pressed Sidekicks on a cold chunk watched its reservation after an explicit
// act, which is the one moment a reservation is not the honest thing to show.
//
// TWO CLAIMS, KEPT APART BECAUSE THE MECHANISMS ARE. The shared section-opening callback
// warms the page it is about to show BEFORE it navigates, and the mount's idle walk warms
// the board before anyone has chosen at all. Either alone leaves a real path cold, and a
// case that could not tell them apart would pass on whichever happened first — which is
// why the walk is pinned here and the order is read off the address the loader saw.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

// Deeply, as every consumer of a `.test-support` module does: a helper that exists for
// suites belongs to the module beside it and not on the family's production door.
import { ManualIdleWarmScheduler } from "../seats/idle-warm.test-support.js";
import type { FrameStore } from "../store/index.js";
import { renderSurface, searchFor, windowAt } from "./SettingsSurface.test-support.js";
import { SettingsPageRegistry, type SettingsPageContext } from "./settings-page-registry.js";
import { SETTINGS_SECTION_LABELS } from "./settings-sections.js";

/** Press the rail row, or the search hit, whose text carries this label. */
function clickSectionLabelled(container: HTMLElement, label: string): void {
  const pressed = [...container.querySelectorAll(".meridian-settings__section")].find((element) =>
    (element.textContent ?? "").includes(label),
  );
  (pressed as HTMLButtonElement | undefined)?.click();
}

/** Which sections a board asked for, and what the address said each time it did. */
interface DeferredPageProbe {
  readonly pages: SettingsPageRegistry;
  readonly loadedSections: string[];
  /** The `#/settings/<page>` segment the route held at each load. */
  readonly pageSegmentsAtLoad: (string | undefined)[];
}

/**
 * One deferred page beside one component-form page, over this window's own store.
 *
 * The loader reads the ROUTE rather than pushing a marker, because the claim is an ORDER
 * and a marker only says that two things happened. A loader that ran after the navigation
 * would see the section it was opening; one that ran before it sees the address the person
 * pressed FROM, which is the only reading that separates them.
 */
function deferredPageProbe(frameStore: FrameStore): DeferredPageProbe {
  const loadedSections: string[] = [];
  const pageSegmentsAtLoad: (string | undefined)[] = [];
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "sidekicks",
    owner: "settings-surface-warm-test",
    label: "Sidekicks",
    keywords: [],
    body: () => {
      loadedSections.push("sidekicks");
      const { route } = frameStore.getState();
      pageSegmentsAtLoad.push(route.kind === "settings" ? route.page : "elsewhere");
      return Promise.resolve<{ Body: (context: SettingsPageContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  pages.register({
    section: "keyboard",
    owner: "settings-surface-warm-test",
    label: "Keyboard",
    keywords: [],
    render: () => null,
  });
  return { pages, loadedSections, pageSegmentsAtLoad };
}

describe("opening a section — the one callback both ways in reach it through", () => {
  // jsdom declares neither half of the idle pair, so an unpinned surface falls to the warm
  // scheduler's 200 ms timeout floor — and a case asking what a PRESS warmed would be
  // racing a walk that warms the same page for a different reason. Installing the
  // package's own manual scheduler as the host pins it: nothing runs until a case says so,
  // which is also what lets the idle cases below read the walk itself.
  let pinnedIdleHost: ManualIdleWarmScheduler;

  beforeEach(() => {
    pinnedIdleHost = new ManualIdleWarmScheduler();
    vi.stubGlobal("requestIdleCallback", pinnedIdleHost.schedule);
    vi.stubGlobal("cancelIdleCallback", pinnedIdleHost.cancel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms a deferred page from the rail, before the route changes", async () => {
    const settingsWindow = windowAt(undefined);
    const probe = deferredPageProbe(settingsWindow.frameStore);
    const { container } = await renderSurface(settingsWindow.context, probe.pages);

    expect(probe.loadedSections).toStrictEqual([]);
    clickSectionLabelled(container, SETTINGS_SECTION_LABELS.sidekicks);

    expect(probe.loadedSections).toStrictEqual(["sidekicks"]);
    // The order, read off the address the loader saw: still the one pressed FROM.
    expect(probe.pageSegmentsAtLoad).toStrictEqual([undefined]);
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: "sidekicks",
    });
  });

  it("warms it the same way from a search hit", async () => {
    // The second entry path, and the reason the call sits in the shared callback rather
    // than beside either control: a copy per control is a copy one of them can be missing.
    const settingsWindow = windowAt(undefined);
    const probe = deferredPageProbe(settingsWindow.frameStore);
    const { container } = await renderSurface(settingsWindow.context, probe.pages);

    searchFor(container, "sidekick");
    clickSectionLabelled(container, SETTINGS_SECTION_LABELS.sidekicks);

    expect(probe.loadedSections).toStrictEqual(["sidekicks"]);
    expect(probe.pageSegmentsAtLoad).toStrictEqual([undefined]);
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: "sidekicks",
    });
  });

  it("asks for nothing when the section it opens is component-form", async () => {
    // The other half of that one line: a `render:` page settles immediately with nothing
    // done, so no caller has to ask first how the page it is opening was registered.
    const settingsWindow = windowAt(undefined);
    const probe = deferredPageProbe(settingsWindow.frameStore);
    const { container } = await renderSurface(settingsWindow.context, probe.pages);

    clickSectionLabelled(container, SETTINGS_SECTION_LABELS.keyboard);

    expect(probe.loadedSections).toStrictEqual([]);
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: "keyboard",
    });
  });
});

describe("the settings mount's idle walk", () => {
  let pinnedIdleHost: ManualIdleWarmScheduler;

  beforeEach(() => {
    pinnedIdleHost = new ManualIdleWarmScheduler();
    vi.stubGlobal("requestIdleCallback", pinnedIdleHost.schedule);
    vi.stubGlobal("cancelIdleCallback", pinnedIdleHost.cancel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms the board before anyone has chosen a section", async () => {
    // The board's lifetime begins when this destination opens, and choosing a section is a
    // second act after that — so the interval a person spends reading the rail is the one a
    // deferred page's chunk is charged to.
    const settingsWindow = windowAt(undefined);
    const probe = deferredPageProbe(settingsWindow.frameStore);
    await renderSurface(settingsWindow.context, probe.pages);

    expect(pinnedIdleHost.pendingCount).toBe(1);
    pinnedIdleHost.runToQuiescence();

    expect(probe.loadedSections).toStrictEqual(["sidekicks"]);
    expect(probe.pages.unloadedKeys()).toStrictEqual([]);
    // A warm is not an open: nothing navigated.
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: undefined,
    });
  });

  it("negative control: a board nobody mounted a surface over stays cold", () => {
    // Without this, every case in this file would pass over a registry that warmed itself
    // on registration — and the press would then be warming something already in flight.
    const probe = deferredPageProbe(windowAt(undefined).frameStore);

    pinnedIdleHost.runToQuiescence();

    expect(probe.loadedSections).toStrictEqual([]);
    expect(probe.pages.unloadedKeys()).toStrictEqual(["sidekicks"]);
  });
});
