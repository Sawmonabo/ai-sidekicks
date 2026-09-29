// The browser section is reachable.
//
// These cases drive the SHIPPED board rather than a registry composed here, because a
// registrar that works and is never called leaves `#/settings/browser` rendering the
// reserved arm — a surface a person cannot reach by any address.
//
// AND THE REGISTRATION IS LOADER-BACKED, which splits those cases in two. The page is a
// chunk of its own — `browser/settings/browser-settings-page-body.ts`, which is what
// keeps a page nobody has opened off every launch's initial import graph — so the
// shipped surface parked on this address renders the page REGION and its reservation,
// and the body itself lands a turn later. The claims are made against the shipped
// surface, and against the reserved mount the family's own scaffolding owns
// (`settings/settings-page-mount.test-support.tsx`).

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "./core/settle.test-support.js";
import { createFixture } from "./bridge/fixture/call-plane/bridge.test-support.js";
import { LiveAnnouncerProvider } from "./primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "./store/index.js";
import { registerSettingsSurface } from "./settings/index.js";
import { registerBrowserSettingsPage } from "./browser-settings-page.js";
import {
  mountReservedSettingsPage,
  settingsPageContextWith,
} from "./settings/settings-page-mount.test-support.js";
import { SettingsPageRegistry } from "./settings/settings-page-registry.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./seats/index.js";
// The pending marker's reader by its own leaf specifier: the seats door publishes the
// ATTRIBUTE, which a producer needs, and not this reader, whose consumers outside that
// directory are tests.
import { pendingPaneBodiesIn } from "./seats/pane/pending-pane-body.js";

afterEach(() => {
  cleanup();
});

/**
 * The settings surface a window mounts, parked on the browser address.
 *
 * Driven through `registerSettingsSurface` rather than around it, so the slot claim is
 * itself a covered fact. What this answers is whether the shipped board claims the
 * section — the page's own contents are the next helper's subject, because this mount
 * holds the page registry the surface composed and no suite may reach for it.
 */
async function renderShippedSettingsAtBrowser(): Promise<HTMLElement> {
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
    bridge: createFixture().bridge,
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

/**
 * The context this page is handed, built by the family's own builder.
 *
 * The page reads nothing from it, but the context is built whole rather than cast: a
 * cast placeholder compiles past exactly the wiring mistake a widened context would
 * otherwise catch here, which is what `settingsPageContextWith` exists to end.
 */
function browserPageContext(): ReturnType<typeof settingsPageContextWith> {
  return settingsPageContextWith(createFixture().bridge, undefined);
}

describe("the browser settings section", () => {
  it("is registered on the shipped board, so its address renders the page region", async () => {
    const container = await renderShippedSettingsAtBrowser();
    // The reserved arm is what an unclaimed section draws, and it is gone: the board
    // claims `browser`. What stands in its place is the page's own reservation, which is
    // the loader form working rather than a page that failed to render.
    expect(container.textContent ?? "").not.toContain("has not been built yet");
    expect(pendingPaneBodiesIn(container).length).toBe(1);
  });

  it("reserves the region rather than the page while its chunk is still arriving", () => {
    // The other side of the loader form, and the negative control for the wait above: an
    // unpreloaded descriptor draws the reservation, so the case above is asserting on a
    // body that landed rather than on one that was there all along. It is also the frame
    // a person sees, and it must carry the pending marker — the screenshot tier refuses
    // to photograph a tree holding one, and a settings page mid-load is exactly what
    // that refusal exists for.
    //
    // SYNCHRONOUS, AND THAT IS THE CASE ITSELF — the reservation is the render that
    // happens before the import resolves, which is why the shared mount has a second,
    // un-awaited half rather than an option on its first.
    const container = mountReservedSettingsPage(
      "browser",
      registerBrowserSettingsPage,
      browserPageContext(),
    );
    expect(container.querySelector("#meridian-browser-settings-title")).toBeNull();
    expect(pendingPaneBodiesIn(container).length).toBe(1);
  });

  it("negative control: the registrar is what puts the page on a board", () => {
    // Without this, the cases above would pass over a board that had grown the section
    // some other way — and this one fails if the registrar stops claiming it.
    const withoutRegistration = new SettingsPageRegistry();
    expect(withoutRegistration.descriptorFor("browser")).toBeUndefined();
    const withRegistration = new SettingsPageRegistry();
    registerBrowserSettingsPage(withRegistration);
    expect(withRegistration.descriptorFor("browser")?.label).toBe("Browser");
  });
});
