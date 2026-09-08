// The browser section is reachable, and what it says when nothing answers.
//
// The page shipped whole and no board registered it, so `#/settings/browser` rendered
// the reserved arm — a built surface a person could not reach by any address. The first
// case drives the SHIPPED board rather than a registry composed here, because a
// registrar that works and is never called is exactly the state this closes.
//
// THE BODY IS AWAITED THROUGH THE REGISTRY'S OWN LOADER, never by settling generously.
// This registration is loader-backed — the page is a chunk of its own, which is what
// keeps it off every launch's initial graph — so a descriptor rendered straight after
// registration draws the reserved region and nothing else. `preload` is the
// registration's memoised loader, so awaiting it is exact:
// `test/console/surfaces/pane-body-resolution.ts` states the same rule for the two boards
// in `seats/`, and the reason a wait must not be a wider settle is there — a dynamic
// import needs more than the one macrotask a render settle crosses, so a case that
// settled twice and passed would be a case that raced.
//
// WHICH SPLITS THE CASES BY WHAT THEY CAN SEE. The shipped surface composes its page
// registry inside its own mount and hands it to nobody, so a case driving that surface
// cannot preload the page and asserts what the SEAM is worth: the section is claimed, its
// address reaches this page's reserved region, and not the settings family's
// not-built-yet arm. The body's own contents are asserted through a registry this file
// owns, with the page's chunk resolved first — the shape `sidekicks-settings-page.test.tsx`
// beside it already takes for the other page registered from the console root.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "./core/settle.test-support.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "./bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "./bridge/readings/scheduled-read.test-support.js";
import { LiveAnnouncerProvider } from "./primitives/index.js";
import { FrameStore, SessionStoreRegistry, UNREPORTED_SHELL_STATE } from "./store/index.js";
import { registerSettingsSurface } from "./settings/index.js";
import { registerBrowserSettingsPage } from "./browser-settings-page.js";
import {
  SettingsPageRegistry,
  type SettingsPageContext,
} from "./settings/settings-page-registry.js";
import { consoleTestUiStateStore } from "./settings/settings-page-mount.test-support.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./seats/index.js";
// The pending marker's reader by its own leaf specifier, on `RouteSurface.test.tsx`'s
// reason: the seats door publishes the ATTRIBUTE, which a producer needs, and not this
// reader, whose consumers outside that directory are tests.
import { pendingPaneBodiesIn, pendingPaneKindsIn } from "./seats/pending-pane-body.js";

afterEach(() => {
  cleanup();
});

/**
 * A bridge whose growth port scripts nothing, which is the state under test.
 *
 * The REAL fixture bridge: the page's two reads go through the growth port, and a
 * hand-built stub would let this file assert a refusal the shipped port does not raise.
 */
function unansweringBridge(): ReturnType<typeof fixtureBridgeWithGrowth> {
  return fixtureBridgeWithGrowth(unscriptedScenario("browser-settings-test"), {});
}

/**
 * The settings surface a window mounts, parked on the browser address.
 *
 * THE FROZEN CLOCK IS MOVED, not just the microtask queue. The section's two reads go
 * through `store/scheduling.ts`'s one `RefreshScheduler`, armed on the fixture's frozen
 * clock — so a helper that only drained promises would assert against a page that had
 * never been given the chance to ask, and read its "still reading" arm as the answer.
 * `settleScheduledRead` is the console's one home for that wait.
 */
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
  const bridge = unansweringBridge();
  const context = {
    route: frameStore.getState().route,
    bridge,
    frameStore,
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
  } as unknown as ConsoleSurfaceContext;
  const { container } = render(
    <LiveAnnouncerProvider>{descriptor.render(context)}</LiveAnnouncerProvider>,
  );
  await act(async () => {
    await settle();
  });
  await settleScheduledRead(bridge);
  return container;
}

/**
 * The page itself, mounted from a registry this file owns with its chunk resolved.
 *
 * A scoped registry per case rather than one shared instance, for the registrar's own
 * reason: the table is owner-scoped state, so two cases sharing one would make the second
 * depend on whether the first had run.
 */
async function renderBrowserPage(): Promise<HTMLElement> {
  const registry = new SettingsPageRegistry();
  registerBrowserSettingsPage(registry);
  await registry.preload("browser");
  const descriptor = registry.descriptorFor("browser");
  if (descriptor === undefined) {
    throw new Error("the browser registrar claimed no settings section");
  }
  const bridge = unansweringBridge();
  const context: SettingsPageContext = {
    bridge,
    openSection: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_SHELL_STATE,
    selection: undefined,
    uiStateStore: consoleTestUiStateStore(),
  };
  const { container } = render(
    <LiveAnnouncerProvider>{descriptor.render(context)}</LiveAnnouncerProvider>,
  );
  await act(async () => {
    await settle();
  });
  await settleScheduledRead(bridge);
  return container;
}

describe("the browser settings section", () => {
  it("is registered on the shipped board, so its address reaches this page", async () => {
    const container = await renderSettingsAtBrowser();
    // What the seam is worth, read off the surface a window actually mounts: the address
    // resolves to THIS page's region rather than the settings family's not-built-yet arm,
    // and the marker names the section so a mistaken registration cannot pass by
    // reserving somebody else's.
    expect(pendingPaneKindsIn(container)).toStrictEqual(["browser"]);
    expect(container.textContent ?? "").not.toContain("has not been built yet");
  });

  it("draws both policy rows and the site-data table, with nothing answered", async () => {
    const container = await renderBrowserPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Two switches this node");
    // Fail-closed AND said so: the rows render the enforced position and carry the
    // port's own refusal beside it, rather than drawing a permissive off nobody set.
    expect(container.querySelectorAll(".meridian-browser-policy > *").length).toBe(2);
    expect(text).toContain("Site data");
    expect(text).toContain("wire-unregistered");
  });

  it("reserves the region rather than the page while its chunk is still arriving", () => {
    // The other side of the loader form, and the negative control for the wait above: an
    // unpreloaded descriptor draws the reservation, so the case above is asserting on a
    // body that landed rather than on one that was there all along. It is also the frame a
    // person sees, and it must carry the pending marker — the screenshot tier refuses to
    // photograph a tree holding one, and a settings page mid-load is exactly what that
    // refusal exists for.
    const registry = new SettingsPageRegistry();
    registerBrowserSettingsPage(registry);
    const descriptor = registry.descriptorFor("browser");
    const bridge = unansweringBridge();
    const context: SettingsPageContext = {
      bridge,
      openSection: () => undefined,
      retainedSessionId: undefined,
      retainedSessionStore: undefined,
      shellState: UNREPORTED_SHELL_STATE,
      selection: undefined,
      uiStateStore: consoleTestUiStateStore(),
    };
    const { container } = render(
      <LiveAnnouncerProvider>{descriptor?.render(context)}</LiveAnnouncerProvider>,
    );
    // ASSERTED ON THE COMMITTED FRAME AND NOT AFTER A SETTLE, which is the whole of the
    // control: under this runner the page's module is already in the graph, so a settle
    // resolves the import and the reservation is gone — the case would then be asserting
    // that a body it had just awaited was absent, and pass for the wrong reason.
    expect(container.textContent ?? "").not.toContain("Two switches this node");
    expect(pendingPaneBodiesIn(container).length).toBe(1);
  });

  it("negative control: the registrar is what puts the page on a board", () => {
    // Without this, the cases above would pass over a board that had grown the
    // section some other way — and this one fails if the registrar stops claiming it.
    const withoutRegistration = new SettingsPageRegistry();
    expect(withoutRegistration.descriptorFor("browser")).toBeUndefined();
    const withRegistration = new SettingsPageRegistry();
    registerBrowserSettingsPage(withRegistration);
    expect(withRegistration.descriptorFor("browser")?.label).toBe("Browser");
  });
});
