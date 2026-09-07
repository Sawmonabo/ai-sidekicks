// The browser section is reachable, and what it says when nothing answers.
//
// The page shipped whole and no board registered it, so `#/settings/browser` rendered
// the reserved arm — a built surface a person could not reach by any address. These
// cases drive the SHIPPED board rather than a registry composed here, because a
// registrar that works and is never called is exactly the state this closes.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "./core/settle.test-support.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "./bridge/fixture/fixture-bridge.test-support.js";
import { LiveAnnouncerProvider } from "./primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "./store/index.js";
import { registerSettingsSurface } from "./settings/index.js";
import { registerBrowserSettingsPage } from "./browser-settings-page.js";
import { SettingsPageRegistry } from "./settings/settings-page-registry.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./seats/index.js";

afterEach(() => {
  cleanup();
});

/** The settings surface a window mounts, parked on the browser address. */
async function renderSettingsAtBrowser(): Promise<HTMLElement> {
  const surfaces = new ConsoleSurfaceRegistry();
  registerSettingsSurface(surfaces);
  await surfaces.preload("settings");
  const descriptor = surfaces.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no surface slot");
  }
  const frameStore = new FrameStore();
  frameStore.navigate({ kind: "settings", page: "browser" });
  const context = {
    route: frameStore.getState().route,
    // The REAL fixture bridge: the page's two reads go through the growth port, and a
    // hand-built stub would let this file assert a refusal the shipped port does not
    // raise. No scenario answers either read, which is the state under test.
    bridge: fixtureBridgeWithGrowth(unscriptedScenario("browser-settings-test"), {}),
    frameStore,
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
  } as unknown as ConsoleSurfaceContext;
  const { container } = render(
    <LiveAnnouncerProvider>{descriptor.render(context)}</LiveAnnouncerProvider>,
  );
  await act(async () => {
    await settle();
  });
  return container;
}

describe("the browser settings section", () => {
  it("is registered on the shipped board, so its address renders the page", async () => {
    const container = await renderSettingsAtBrowser();
    const text = container.textContent ?? "";
    expect(text).toContain("Two switches this node");
    expect(text).not.toContain("has not been built yet");
  });

  it("draws both policy rows and the site-data table, with nothing answered", async () => {
    const container = await renderSettingsAtBrowser();
    // Fail-closed AND said so: the rows render the enforced position and carry the
    // port's own refusal beside it, rather than drawing a permissive off nobody set.
    expect(container.querySelectorAll(".meridian-browser-policy > *").length).toBe(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Site data");
    expect(text).toContain("wire-unregistered");
  });

  it("negative control: the registrar is what puts the page on a board", () => {
    // Without this, the two cases above would pass over a board that had grown the
    // section some other way — and this one fails if the registrar stops claiming it.
    const withoutRegistration = new SettingsPageRegistry();
    expect(withoutRegistration.descriptorFor("browser")).toBeUndefined();
    const withRegistration = new SettingsPageRegistry();
    registerBrowserSettingsPage(withRegistration);
    expect(withRegistration.descriptorFor("browser")?.label).toBe("Browser");
  });
});
