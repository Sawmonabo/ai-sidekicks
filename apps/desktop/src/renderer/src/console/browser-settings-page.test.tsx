// The browser section is reachable, and what it says when nothing answers.
//
// The page shipped whole and no board registered it, so `#/settings/browser` rendered
// the reserved arm — a built surface a person could not reach by any address. These
// cases drive the SHIPPED board rather than a registry composed here, because a
// registrar that works and is never called is exactly the state this closes.
//
// AND THE REGISTRATION IS LOADER-BACKED, which splits those cases in two. The page is a
// chunk of its own — `browser/settings/browser-settings-page-body.ts`, which is what
// keeps twelve modules of a page nobody has opened off every launch's initial import
// graph — so the shipped surface parked on this address renders the page REGION and its
// reservation, and the body itself lands a turn later. The two claims are therefore made
// against two subjects: that the shipped board claims the section, read off the shipped
// surface; and what the body draws once it is here, read off a registry whose loader has
// been awaited.
//
// THE BODY IS AWAITED THROUGH THE REGISTRY'S OWN LOADER, never by settling generously.
// `preload` is the registration's memoised loader, so awaiting it is exact:
// `sidekicks-settings-page.test.tsx` beside this one takes the same wait for the same
// reason, and `test/console/surfaces/pane-body-resolution.ts` states the rule for the two
// boards in `seats/` — a dynamic import needs more than the one macrotask a render settle
// crosses, so a case that settled twice and passed would be a case that raced.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "./core/settle.test-support.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "./bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "./bridge/readings/scheduled-read.test-support.js";
import { LiveAnnouncerProvider } from "./primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "./store/index.js";
import { registerSettingsSurface } from "./settings/index.js";
import { registerBrowserSettingsPage } from "./browser-settings-page.js";
import {
  SettingsPageRegistry,
  type SettingsPageContext,
} from "./settings/settings-page-registry.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./seats/index.js";
// The pending marker's reader by its own leaf specifier, on `sidekicks-settings-page`'s
// reason: the seats door publishes the ATTRIBUTE, which a producer needs, and not this
// reader, whose consumers outside that directory are tests.
import { pendingPaneBodiesIn } from "./seats/pending-pane-body.js";

afterEach(() => {
  cleanup();
});

/**
 * The fixture bridge both subjects read through.
 *
 * THE REAL FIXTURE BRIDGE: the page's two reads go through the growth port, and a
 * hand-built stub would let this file assert a refusal the shipped port does not raise.
 * No scenario answers either read, which is the state under test.
 */
function unansweredBridge(): ReturnType<typeof fixtureBridgeWithGrowth> {
  return fixtureBridgeWithGrowth(unscriptedScenario("browser-settings-test"), {});
}

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
    bridge: unansweredBridge(),
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
 * The page itself, rendered off a registry whose loader has been awaited.
 *
 * A scoped registry per case rather than one shared instance, for the registrar's own
 * reason: the table is owner-scoped state, so two cases sharing one would make the second
 * depend on whether the first had run.
 *
 * THE FROZEN CLOCK IS MOVED, not just the microtask queue. The section's two reads go
 * through `store/scheduling.ts`'s one `RefreshScheduler`, armed on the fixture's frozen
 * clock — so a helper that only drained promises would assert against a page that had
 * never been given the chance to ask, and read its "still reading" arm as the answer.
 * `settleScheduledRead` is the console's one home for that wait.
 */
async function renderBrowserPageBody(): Promise<HTMLElement> {
  const registry = new SettingsPageRegistry();
  registerBrowserSettingsPage(registry);
  await registry.preload("browser");
  const descriptor = registry.descriptorFor("browser");
  if (descriptor === undefined) {
    throw new Error("the browser registrar claimed no settings section");
  }
  const bridge = unansweredBridge();
  const { container } = render(
    <LiveAnnouncerProvider>
      {descriptor.render({ bridge } as unknown as SettingsPageContext)}
    </LiveAnnouncerProvider>,
  );
  await act(async () => {
    await settle();
  });
  await settleScheduledRead(bridge);
  return container;
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

  it("draws both policy rows and the site-data table, with nothing answered", async () => {
    const container = await renderBrowserPageBody();
    expect(container.textContent ?? "").toContain("Two switches this node");
    // Fail-closed AND said so: the rows render the enforced position and carry the
    // port's own refusal beside it, rather than drawing a permissive off nobody set.
    expect(container.querySelectorAll(".meridian-browser-policy > *").length).toBe(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Site data");
    expect(text).toContain("wire-unregistered");
  });

  it("reserves the region rather than the page while its chunk is still arriving", () => {
    // The other side of the loader form, and the negative control for the wait above: an
    // unpreloaded descriptor draws the reservation, so the case above is asserting on a
    // body that landed rather than on one that was there all along. It is also the frame
    // a person sees, and it must carry the pending marker — the screenshot tier refuses
    // to photograph a tree holding one, and a settings page mid-load is exactly what
    // that refusal exists for.
    //
    // SYNCHRONOUS, AND THAT IS THE CASE ITSELF. The reservation is the render that
    // happens before the import resolves, so a case that settled first would be asking
    // about a body that had already landed — under vitest the module graph is already
    // transformed and one settle is enough for it to. `sidekicks-settings-page.test.tsx`
    // makes the same claim the same way for the same reason.
    const registry = new SettingsPageRegistry();
    registerBrowserSettingsPage(registry);
    const descriptor = registry.descriptorFor("browser");
    const bridge = unansweredBridge();
    const { container } = render(
      <LiveAnnouncerProvider>
        {descriptor?.render({ bridge } as unknown as SettingsPageContext)}
      </LiveAnnouncerProvider>,
    );
    expect(container.textContent ?? "").not.toContain("Two switches this node");
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
