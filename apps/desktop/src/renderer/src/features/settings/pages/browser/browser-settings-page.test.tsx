// The browser section is reachable.
//
// These cases drive the SHIPPED board rather than a registry composed here, because a
// registrar that works and is never called leaves `#/settings/browser` rendering the
// reserved arm — a surface a person cannot reach by any address.
//
// The registration is loader-backed: the page is a chunk of its own
// (`pages/browser/browser-settings-page-body.ts`), which keeps a page nobody has opened off
// every launch's initial import graph, so the shipped surface parked on this address renders
// the page region and its reservation, and the body lands a turn later.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { createFixture } from "@test/helpers/fixture-bridge.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { registerSettingsScreen } from "../../contributions/screens.js";
import { SETTINGS_PAGES, SettingsPageRegistry } from "../../settings-pages.js";
import { ScreenRegistry, type ScreenContext } from "@renderer/console/seats/index.js";
// The pending marker's reader by its own leaf specifier: the seats door publishes the
// ATTRIBUTE, which a producer needs, and not this reader, whose consumers outside that
// directory are tests.
import { findPendingBodies } from "@renderer/components/LazyBody/pending-body-marker.js";

afterEach(() => {
  cleanup();
});

/**
 * The settings surface a window mounts, parked on the browser address.
 *
 * Driven through `registerSettingsScreen` rather than around it, so the slot claim is
 * itself a covered fact. What this answers is whether the shipped board claims the
 * section — the page's own contents are the next helper's subject, because this mount
 * holds the page registry the surface composed and no suite may reach for it.
 */
async function renderShippedSettingsAtBrowser(): Promise<HTMLElement> {
  const surfaces = new ScreenRegistry();
  registerSettingsScreen(surfaces);
  await surfaces.preload("settings");
  const descriptor = surfaces.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no surface slot");
  }
  const frameStore = new WindowStore();
  frameStore.navigate({ kind: "settings", page: "browser" });
  const context = {
    route: frameStore.getState().route,
    bridge: createFixture().bridge,
    frameStore,
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
    chooseScheme: () => undefined,
  } as unknown as ScreenContext;
  const { container } = render(
    <LiveAnnouncerProvider>{descriptor.render(context)}</LiveAnnouncerProvider>,
  );
  await act(async () => {
    await settle();
  });
  return container;
}

/** The page table's Browser entry, registered on a board the case owns. */
function registerBrowserPage(registry: SettingsPageRegistry): void {
  const entry = SETTINGS_PAGES.find((page) => page.section === "browser");
  if (entry === undefined) {
    throw new Error("the page table holds no Browser entry");
  }
  registry.register(entry);
}

describe("the browser settings section", () => {
  it("is registered on the shipped board, so its address renders the page region", async () => {
    const container = await renderShippedSettingsAtBrowser();
    // The reserved arm is what an unclaimed section draws, and it is gone: the board
    // claims `browser`. What stands in its place is the page's own reservation, which is
    // the loader form working rather than a page that failed to render.
    expect(container.textContent ?? "").not.toContain("has not been built yet");
    expect(findPendingBodies(container).length).toBe(1);
  });

  it("negative control: the table's entry is what puts the page on a board", () => {
    // Without this, the cases above would pass over a board that had grown the section
    // some other way — and this one fails if the table stops holding it.
    const withoutRegistration = new SettingsPageRegistry();
    expect(withoutRegistration.descriptorFor("browser")).toBeUndefined();
    const withRegistration = new SettingsPageRegistry();
    registerBrowserPage(withRegistration);
    expect(withRegistration.descriptorFor("browser")?.label).toBe("Browser");
  });
});
