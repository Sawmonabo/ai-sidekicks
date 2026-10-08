// How a case drives the settings screen: the window it is parked in, and the mount.

import { render } from "@testing-library/react";

import { settle } from "#test/helpers/settle.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { type LiveAnnouncer } from "#renderer/components/LiveAnnouncer/announcer.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { registerSettingsScreen } from "./contributions/screens.js";
import { type SettingsPageRegistry } from "./pages/registry.js";
import { ScreenRegistry, type ScreenDescriptor } from "#renderer/registries/screens/registry.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";
import { openingPageLimit } from "#test/helpers/session/store/fixtures.js";

/**
 * The render a window mounts, taken from the shipped registrar.
 *
 * Going through `registerSettingsScreen` keeps the page set from being copied here, and
 * fails a suite if the registrar claims no screen.
 */
async function loadShippedScreenRender(): Promise<ScreenDescriptor["render"]> {
  const screens = new ScreenRegistry();
  registerSettingsScreen(screens);
  // Preload first, as a window does, so cases assert on the page list and not on how many turns
  // a dynamic import takes.
  await screens.preload("settings");
  const descriptor = screens.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no screen");
  }
  return descriptor.render;
}

/**
 * That chunk, fetched once per suite and warmed off the per-case clock.
 *
 * The first case to await it pays the transform for a dozen page modules and their
 * stylesheets; under load that exceeds the 5 s per-case default, and the abandoned render
 * leaves a document that fails every later case. Held in a class field, awaited once in
 * `beforeAll`.
 */
class ShippedScreenRenderHolder {
  #fetched: Promise<ScreenDescriptor["render"]> | undefined;

  public fetch(): Promise<ScreenDescriptor["render"]> {
    this.#fetched ??= loadShippedScreenRender();
    return this.#fetched;
  }
}

const shippedScreenRenderHolder = new ShippedScreenRenderHolder();

/** The shipped render, fetched on the first ask and handed back on every one after it. */
export function shippedScreenRender(): Promise<ScreenDescriptor["render"]> {
  return shippedScreenRenderHolder.fetch();
}

/**
 * Long enough for a cold transform of that chunk on a loaded machine.
 *
 * A suite's cold run measured about 50 s under load and about 1 s with a warm transform
 * cache; the bound is roughly twice the worst case. It gates nothing else, so a tight bound
 * only reintroduces the cascade it prevents.
 */
export const CHUNK_WARM_TIMEOUT_MS = 120_000;

/** A window parked on a settings address, plus the store that remembers where it has been. */
export interface SettingsWindow {
  readonly context: ScreenContext;
  readonly frameStore: WindowStore;
}

/**
 * Open the sessions named, then park on a settings address.
 *
 * The frame store is the real one: a stub could assert a contract the shipped store lacks,
 * and a case reads a getter on it.
 */
export function windowAt(
  page: string | undefined,
  openedSessionIds: readonly string[] = [],
): SettingsWindow {
  const frameStore = new WindowStore();
  for (const sessionId of openedSessionIds) {
    frameStore.navigate({ kind: "session", sessionId });
  }
  frameStore.navigate({ kind: "settings", page });
  const uiStateStore = UiStateStore.opening();
  return {
    frameStore,
    context: {
      route: frameStore.getState().route,
      bridge: createFixtureBridge({ scenario: unscriptedScenario("settings-screen") }).bridge,
      frameStore,
      sessionStore: undefined,
      // The real registry: a stub could assert a resolution the shipped one does not make.
      // No session is opened on it, the ordinary case for a settings window.
      sessionStoreRegistry: new SessionStoreRegistry({
        openingPageLimit,
        read: () => Promise.resolve(undefined),
      }),
      paneRegistry: new PaneRegistry(),
      uiStateStore,
      draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
      lastSettingsPage: new LastSettingsPage(uiStateStore),
      chooseScheme: () => undefined,
    },
  };
}

/**
 * Render the settings screen the way a window mounts it, on the address it was parked at.
 *
 * The bridge and the announcer are part of the mount because a page lands through the window's
 * clock and settings pages announce; both hooks throw outside their providers. Omitting `pages`
 * renders the shipped composition through the registrar; `announcer` is one a case reads what was
 * said from. Settles afterward because the shipped arm is loader-backed: the first commit shows
 * the reserved frame and the pages arrive a macrotask later.
 */
export async function renderSettingsScreen(
  context: ScreenContext,
  pages?: SettingsPageRegistry,
  announcer?: LiveAnnouncer,
): Promise<ReturnType<typeof render>> {
  const screenElement =
    pages === undefined ? (
      (await shippedScreenRender())(context)
    ) : (
      <SettingsScreen context={context} pages={pages} />
    );
  const rendered = render(
    <PlatformBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>{screenElement}</LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  // The lazy component suspends on its first render, so the body lands one boundary later.
  await settle();
  return rendered;
}

/**
 * Render the settings screen over a registry the case owns, following the window's route as the
 * router does: each settings address re-renders it, and any other address takes it away.
 */
export async function renderRoutedSettingsScreen(
  settingsWindow: SettingsWindow,
  pages: SettingsPageRegistry,
): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <PlatformBridgeProvider bridge={settingsWindow.context.bridge}>
      <LiveAnnouncerProvider>
        <RoutedSettingsScreen context={settingsWindow.context} pages={pages} />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  await settle();
  return rendered;
}

/** The screen while the window's route is a settings address, and nothing on any other. */
function RoutedSettingsScreen(props: {
  readonly context: ScreenContext;
  readonly pages: SettingsPageRegistry;
}): React.JSX.Element | null {
  const route = useWindowStore(props.context.frameStore, (state) => state.route);
  return route.kind === "settings" ? (
    <SettingsScreen context={{ ...props.context, route }} pages={props.pages} />
  ) : null;
}
