// What the settings screen enforces: the open section lives in the route, and the pane is
// handed the retained session, subscribed, and never the route's projection (which is
// `undefined` on every settings address).

import { act } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { SettingsPageRegistry } from "./settings-pages.js";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import {
  CHUNK_WARM_TIMEOUT_MS,
  renderSettingsScreen,
  shippedScreenRender,
  windowAt,
} from "./SettingsScreen.test-support.js";

// Warm the settings chunk in a hook so no case pays for it.
beforeAll(async () => {
  await shippedScreenRender();
}, CHUNK_WARM_TIMEOUT_MS);

/**
 * Class of the probe page's echo of the retained session id.
 *
 * The probe is a page that renders only that id: the claim is the screen's handoff, not a
 * real page's wire, and the DOM is asserted because it is what a person sees.
 */
const SESSION_ECHO_CLASS = "settings-screen-test__session";

function sessionEchoPages(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "runtime",
    label: "Runtime",
    keywords: [],
    render: (pageContext) => (
      <p className={SESSION_ECHO_CLASS}>{pageContext.retainedSessionId ?? "no session"}</p>
    ),
  });
  return pages;
}

function echoedSession(container: HTMLElement): string | undefined {
  return container.querySelector(`.${SESSION_ECHO_CLASS}`)?.textContent ?? undefined;
}

describe("settings rail", () => {
  it("navigates rather than holding the selection in a local", async () => {
    // A local would make a rail click and a deep link different acts and break back.
    const settingsWindow = windowAt(undefined);
    const { container } = await renderSettingsScreen(settingsWindow.context);
    const entry = container.querySelector(".meridian-settings__section");
    (entry as HTMLButtonElement | null)?.click();
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: SETTINGS_PAGE_IDS[0],
    });
  });
});

describe("the session a settings page is handed", () => {
  it("hands down the session this window opened, on an address that names none", async () => {
    const settingsWindow = windowAt("runtime", ["session-alpha"]);
    const { container } = await renderSettingsScreen(settingsWindow.context, sessionEchoPages());
    expect(echoedSession(container)).toBe("session-alpha");
    // The route projection is `undefined` on this address, so a page fed from it would never
    // see a session; both readings are taken of one window for the contrast.
    expect(settingsWindow.frameStore.activeSessionId).toBeUndefined();
  });

  it("follows the retained session rather than the value it read at mount", async () => {
    // Fails on a snapshot read at mount; passes only on a store subscription.
    const settingsWindow = windowAt("runtime", ["session-alpha"]);
    const { container } = await renderSettingsScreen(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "session", sessionId: "session-beta" });
    });
    expect(echoedSession(container)).toBe("session-beta");
  });
});
