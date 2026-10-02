// How a case drives the settings screen: the window it is parked in, and the mount.

import { render } from "@testing-library/react";

import { settle } from "@test/helpers/settle.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { registerSettingsScreen } from "./contributions/screens.js";
import { type SettingsPageRegistry } from "./settings-pages.js";
import {
  ScreenRegistry,
  type ScreenDescriptor,
} from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

/**
 * The render a window mounts, taken from the shipped registrar.
 *
 * Going through `registerSettingsScreen` keeps the page set from being copied here, and
 * fails a suite if the registrar claims no screen.
 */
async function loadShippedScreenRender(): Promise<ScreenDescriptor["render"]> {
  const screens = new ScreenRegistry();
  registerSettingsScreen(screens);
  // Preload first, as a window does, so cases assert on the rail and not on how many turns
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
  return {
    frameStore,
    context: {
      route: frameStore.getState().route,
      bridge: createFixtureBridge({ scenario: unscriptedScenario("settings-screen") }).bridge,
      frameStore,
      sessionStore: undefined,
      // The real registry: a stub could assert a resolution the shipped one does not make.
      // No session is opened on it, the ordinary case for a settings window.
      sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
      paneRegistry: new PaneRegistry(),
      uiStateStore: UiStateStore.opening(),
      draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
      chooseScheme: () => undefined,
    },
  };
}

/**
 * Render the settings screen the way a window mounts it.
 *
 * The announcer is part of the mount because settings pages announce and `useAnnounce`
 * throws outside its provider. Omitting `pages` renders the shipped composition through the
 * registrar. Settles afterward because the shipped arm is loader-backed: the first commit
 * shows the reserved frame and the pages arrive a macrotask later.
 */
export async function renderSettingsScreen(
  context: ScreenContext,
  pages?: SettingsPageRegistry,
): Promise<ReturnType<typeof render>> {
  const screenElement =
    pages === undefined ? (
      (await shippedScreenRender())(context)
    ) : (
      <SettingsScreen context={context} pages={pages} />
    );
  const rendered = render(<LiveAnnouncerProvider>{screenElement}</LiveAnnouncerProvider>);
  // The lazy component suspends on its first render, so the body lands one boundary later.
  await settle();
  return rendered;
}
