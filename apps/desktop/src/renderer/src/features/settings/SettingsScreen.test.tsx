// What the settings screen enforces: the rail always lists every section, the pane names an
// unknown address, the open section lives in the route, and the pane is handed the retained
// session, subscribed, and never the route's projection (which is `undefined` on every
// settings address). When deferred pages are fetched is covered in
// `SettingsScreen.page-warm.test.ts`.

import { act } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { SettingsPageRegistry } from "./settings-pages.js";
import { SETTINGS_PAGE_IDS } from "@renderer/routing/settings-page-ids.js";
import {
  CHUNK_WARM_TIMEOUT_MS,
  renderSettingsScreen,
  searchFor,
  shippedScreenRender,
  windowAt,
} from "./SettingsScreen.test-support.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";

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
    owner: "settings-screen-test",
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

/** Text the probe page renders. */
const PROBE_PAGE_MARKER = "settings-screen-test probe page";

/** One page registered for the section the reservation case leaves empty. */
function registeredProbePage(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "keyboard",
    owner: "settings-screen-test",
    label: "Keyboard",
    keywords: [],
    render: () => <p>{PROBE_PAGE_MARKER}</p>,
  });
  return pages;
}

/** A context parked on the given settings address. */
function contextFor(page: string | undefined): ScreenContext {
  return windowAt(page).context;
}

function railLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-settings__section")].map(
    (element) => element.textContent ?? "",
  );
}

describe("settings rail — every section, always", () => {
  it("renders one entry per declared section", async () => {
    // Driven from the declared set: a rail built from the registry would shrink to whatever
    // is built.
    const { container } = await renderSettingsScreen(contextFor(undefined));
    expect(railLabels(container)).toHaveLength(SETTINGS_PAGE_IDS.length);
  });

  it("marks the section the address names, and only that one", async () => {
    const { container } = await renderSettingsScreen(contextFor("keyboard"));
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Keyboard");
  });

  it("negative control: an address naming no section marks nothing", async () => {
    // Guards against a rail that marks its first entry when nothing is selected.
    const { container } = await renderSettingsScreen(contextFor(undefined));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

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

describe("settings pane", () => {
  it("invites a choice when the address names none", async () => {
    const { container } = await renderSettingsScreen(contextFor(undefined));
    expect(container.textContent ?? "").toContain("Choose a section.");
  });

  it("names an address it does not recognize back to the reader", async () => {
    const { container } = await renderSettingsScreen(contextFor("not-a-section"));
    const text = container.textContent ?? "";
    expect(text).toContain("not-a-section");
    expect(text).toContain("does not name a section");
  });

  it("renders a registered page in the pane", async () => {
    const { container } = await renderSettingsScreen(contextFor("keyboard"), registeredProbePage());
    expect(container.textContent ?? "").toContain(PROBE_PAGE_MARKER);
  });
});

describe("settings search — one field above the rail", () => {
  it("replaces the rail with ranked hits while a query stands", async () => {
    const { container } = await renderSettingsScreen(contextFor(undefined));
    searchFor(container, "mcp");
    expect(railLabels(container).length).toBeLessThan(SETTINGS_PAGE_IDS.length);
    expect(container.textContent ?? "").toContain("MCP servers");
  });

  it("names the query and what was searched when nothing matches", async () => {
    const { container } = await renderSettingsScreen(contextFor(undefined));
    searchFor(container, "zzzzq");
    const text = container.textContent ?? "";
    expect(text).toContain("zzzzq");
    expect(text).toContain("Every section was searched");
  });

  it("negative control: clearing the query restores every section", async () => {
    // Guards against a screen that filters the rail permanently after the first keystroke.
    const { container } = await renderSettingsScreen(contextFor(undefined));
    searchFor(container, "mcp");
    searchFor(container, "");
    expect(railLabels(container)).toHaveLength(SETTINGS_PAGE_IDS.length);
  });

  /**
   * Presses the hit row named `label`.
   *
   * Reach is asserted as focus: the viewport following focus is the platform's, and a scroll
   * offset in a layout-free DOM asserts nothing.
   */
  function pressHit(container: HTMLElement, label: string): void {
    const hits = [...container.querySelectorAll(".meridian-settings__section--result")];
    const hit = hits.find((element) => (element.textContent ?? "").includes(label));
    if (hit === undefined) {
      throw new Error(`no search hit named ${label}`);
    }
    act(() => {
      (hit as HTMLButtonElement).click();
    });
  }

  it("lands the reader on the page a hit names, and settles it once", async () => {
    const { container } = await renderSettingsScreen(contextFor("runtime"), sessionEchoPages());
    const page = container.querySelector(".meridian-settings__page");
    expect(page?.className).not.toContain("--settling");

    searchFor(container, "runtime");
    pressHit(container, "Runtime");

    const heading = container.querySelector(".meridian-settings__page-heading");
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector(".meridian-settings__page")?.className).toContain("--settling");
  });

  it("settles again on a second hit into the section already open", async () => {
    // A boolean would already be true, so a second press would change nothing.
    const { container } = await renderSettingsScreen(contextFor("runtime"), sessionEchoPages());
    searchFor(container, "runtime");
    pressHit(container, "Runtime");
    const page = container.querySelector(".meridian-settings__page");
    // jsdom runs no animation, so fire the `animationend` the browser would.
    act(() => {
      page?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(container.querySelector(".meridian-settings__page")?.className).not.toContain(
      "--settling",
    );

    pressHit(container, "Runtime");
    expect(container.querySelector(".meridian-settings__page")?.className).toContain("--settling");
  });

  it("negative control: opening a section from the rail settles nothing", async () => {
    // Guards against a page that flashes on every arrival, not only on a search hit.
    const { container } = await renderSettingsScreen(contextFor("runtime"), sessionEchoPages());
    const railEntry = container.querySelector(".meridian-settings__section");
    act(() => {
      (railEntry as HTMLButtonElement).click();
    });
    expect(container.querySelector(".meridian-settings__page")?.className).not.toContain(
      "--settling",
    );
    expect(document.activeElement).not.toBe(
      container.querySelector(".meridian-settings__page-heading"),
    );
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

  it("hands down nothing in a window that has opened no session", async () => {
    const { container } = await renderSettingsScreen(
      windowAt("runtime").context,
      sessionEchoPages(),
    );
    expect(echoedSession(container)).toBe("no session");
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

  it("negative control: an unrelated frame change does not rewrite the session", async () => {
    // Guards against a re-read on every notification; opening the palette says nothing about
    // the session.
    const settingsWindow = windowAt("runtime", ["session-alpha"]);
    const { container } = await renderSettingsScreen(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.setPaletteOpen(true);
    });
    expect(echoedSession(container)).toBe("session-alpha");
  });
});
