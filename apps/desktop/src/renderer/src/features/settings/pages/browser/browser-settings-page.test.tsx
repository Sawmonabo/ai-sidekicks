// The browser section is reachable. These cases drive the shipped board: a registrar that is
// never called would leave `#/settings/browser` on the reserved arm. The page is loader-backed
// (`browser-settings-page-body.ts`), so the shipped screen first renders the page region and
// its reservation and the body lands a turn later.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { createFixture } from "@test/helpers/fixture-bridge.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { registerSettingsScreen } from "../../contributions/screens.js";
import { SETTINGS_PAGES, SettingsPageRegistry } from "../../settings-pages.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
// The pending marker's reader by its own leaf specifier; the registries' shared entry exports
// only the attribute, and this reader's consumers outside that directory are tests.
import { findPendingBodies } from "@renderer/components/LazyBody/pending-body-marker.js";

afterEach(() => {
  cleanup();
});

/**
 * The settings screen a window mounts, parked on the browser address.
 *
 * Driven through `registerSettingsScreen` so the screen claim is itself covered; it answers
 * whether the shipped board claims the section, not what the page contains.
 */
async function renderShippedSettingsAtBrowser(): Promise<HTMLElement> {
  const screens = new ScreenRegistry();
  registerSettingsScreen(screens);
  await screens.preload("settings");
  const descriptor = screens.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no screen");
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
    // The reserved arm is what an unclaimed section draws; the page's own reservation in its
    // place shows the loader form working.
    expect(container.textContent ?? "").not.toContain("has not been built yet");
    expect(findPendingBodies(container).length).toBe(1);
  });

  it("negative control: the table's entry is what puts the page on a board", () => {
    // Guards against a board that grew the section some other way; fails if the table stops
    // holding it.
    const withoutRegistration = new SettingsPageRegistry();
    expect(withoutRegistration.descriptorFor("browser")).toBeUndefined();
    const withRegistration = new SettingsPageRegistry();
    registerBrowserPage(withRegistration);
    expect(withRegistration.descriptorFor("browser")?.label).toBe("Browser");
  });
});
