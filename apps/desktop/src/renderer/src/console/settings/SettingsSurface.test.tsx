// The four rules the settings surface is the enforcement of.
//
// Two of them are invisible to the type system and would go wrong quietly: a rail
// that shrinks when a wire is unavailable teaches a person the setting does not
// exist, and a pane that swallows an unknown address leaves a bad deep link looking
// like a working one. The third — that the open section lives in the route and not
// in a local — is what makes a deep link and a rail click the same act.
//
// The fourth is the session a page is handed. Every settings address is
// `kind: "settings"` and names no session, so the frame store's ROUTE PROJECTION is
// `undefined` on all of them; a page handed that would render its no-session arm in
// every window that had ever opened a session, which is a constant dressed as an
// absence. The pane is handed the RETAINED session instead, subscribed rather than
// snapshotted.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { SettingsSurface } from "./SettingsSurface.js";
import { registerSettingsPages } from "./index.js";
import { SETTINGS_SECTION_IDS, SettingsPageRegistry } from "./settings-page-registry.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";

/** The pages the shipped registrar composes — the same ones a window renders. */
function shippedPages(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  registerSettingsPages(pages);
  return pages;
}

/**
 * One page that renders the session member and nothing else.
 *
 * A probe rather than a shipped page, because the claim under test is the SURFACE's:
 * which session it hands down. Driving it through a real page would make the case
 * fail for that page's own wire instead, and asserting on a recorded callback would
 * let a snapshot read pass — the DOM is what a person sees, so the DOM is asserted.
 */
const SESSION_ECHO_CLASS = "settings-surface-test__session";

function sessionEchoPages(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "cost",
    owner: "settings-surface-test",
    label: "Cost",
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

/** A window parked on a settings address, plus the store that remembers where it has been. */
interface SettingsWindow {
  readonly context: ConsoleSurfaceContext;
  readonly frameStore: FrameStore;
}

/**
 * Open the sessions named, then park on a settings address.
 *
 * The frame store is the REAL one rather than a stub: the retained session is state
 * a route transition writes, so a hand-built object would let this file assert a
 * contract the shipped store does not have — and the projection this surface must
 * NOT read is a getter on that same store, which is what makes the negative control
 * mean something.
 */
function windowAt(
  page: string | undefined,
  openedSessionIds: readonly string[] = [],
): SettingsWindow {
  const frameStore = new FrameStore();
  for (const sessionId of openedSessionIds) {
    frameStore.navigate({ kind: "workspace", sessionId });
  }
  frameStore.navigate({ kind: "settings", page });
  return {
    frameStore,
    context: {
      route: frameStore.getState().route,
      bridge: { source: "fixture" },
      frameStore,
      // The REAL registry rather than a stub: the surface resolves the retained
      // session's store through it, so a hand-built object would let this file
      // assert a resolution the shipped registry does not perform. No session is
      // opened on it here — a settings window that has opened none is the ordinary
      // case, and it is the one this harness renders.
      sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
    } as unknown as ConsoleSurfaceContext,
  };
}

/** The four fields this surface reads, and nothing else. */
function contextFor(page: string | undefined): ConsoleSurfaceContext {
  return windowAt(page).context;
}

/**
 * Render the surface the way a window mounts it.
 *
 * The announcer is part of that mount: a settings page that settles an act says so,
 * and `useAnnounce` throws outside the provider deliberately — so a harness that
 * omitted it would fail inside a page and report a missing live region as a broken
 * settings pane.
 */
function renderSurface(
  context: ConsoleSurfaceContext,
  pages: SettingsPageRegistry = shippedPages(),
): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider>
      <SettingsSurface context={context} pages={pages} />
    </LiveAnnouncerProvider>,
  );
}

function railLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-settings__section")].map(
    (element) => element.textContent ?? "",
  );
}

describe("settings rail — every section, always", () => {
  it("renders one entry per declared section", () => {
    // The claim is about a SET, so the case drives the set. A rail assembled from
    // the registry instead would shrink to whatever has been built, which is the
    // "never hides an entry because its wire is unavailable" rule inverted.
    const { container } = renderSurface(contextFor(undefined));
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });

  it("marks the section the address names, and only that one", () => {
    const { container } = renderSurface(contextFor("keyboard"));
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Keyboard");
  });

  it("negative control: an address naming no section marks nothing", () => {
    // Without this, the case above would pass over a rail that marked its first
    // entry whenever nothing else was selected — which would make `#/settings`
    // look like a section had been chosen.
    const { container } = renderSurface(contextFor(undefined));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it("navigates rather than holding the selection in a local", () => {
    // The open section lives in the route. A local would make a rail click and a
    // deep link two different acts, and the back button would stop working.
    const settingsWindow = windowAt(undefined);
    const { container } = renderSurface(settingsWindow.context);
    const entry = container.querySelector(".meridian-settings__section");
    (entry as HTMLButtonElement | null)?.click();
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: SETTINGS_SECTION_IDS[0],
    });
  });
});

describe("settings pane — the three ways there is no page", () => {
  it("invites a choice when the address names none", () => {
    const { container } = renderSurface(contextFor(undefined));
    expect(container.textContent ?? "").toContain("Choose a section.");
  });

  it("names an address it does not recognise back to the reader", () => {
    const { container } = renderSurface(contextFor("not-a-section"));
    const text = container.textContent ?? "";
    expect(text).toContain("not-a-section");
    expect(text).toContain("does not name a section");
  });

  it("says a section's page is reserved rather than drawing an empty pane", () => {
    // An EMPTY registry rather than the shipped one. The claim is the pane's — a
    // section whose page nobody registered says so — and pinning it to whichever
    // section happens to be unbuilt this week made it fail the moment that
    // section's lane landed, which is a stale test rather than a real regression.
    const { container } = renderSurface(contextFor("keyboard"), new SettingsPageRegistry());
    expect(container.textContent ?? "").toContain("has not been built yet");
  });

  it("renders a registered page instead of the reservation", () => {
    // Negative control for the case above: it would pass over a pane that rendered
    // the reservation for every section, registered or not. `mcp-servers` carries a
    // page in this build — its body is another plan's, but the PAGE is registered.
    const { container } = renderSurface(contextFor("mcp-servers"));
    expect(container.textContent ?? "").toContain("MCP server page");
  });
});

describe("settings search — one field above the rail", () => {
  function searchFor(container: HTMLElement, query: string): void {
    const field = container.querySelector(".meridian-settings__search-input");
    const input = field as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("replaces the rail with ranked hits while a query stands", () => {
    const { container } = renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    expect(railLabels(container).length).toBeLessThan(SETTINGS_SECTION_IDS.length);
    expect(container.textContent ?? "").toContain("MCP servers");
  });

  it("names the query and what was searched when nothing matches", () => {
    const { container } = renderSurface(contextFor(undefined));
    searchFor(container, "zzzzq");
    const text = container.textContent ?? "";
    expect(text).toContain("zzzzq");
    expect(text).toContain("Every section was searched");
  });

  it("negative control: clearing the query restores every section", () => {
    // Without this, the first case would pass over a surface that filtered the rail
    // permanently on the first keystroke.
    const { container } = renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    searchFor(container, "");
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });
});

describe("the session a settings page is handed", () => {
  it("hands down the session this window opened, on an address that names none", () => {
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = renderSurface(settingsWindow.context, sessionEchoPages());
    expect(echoedSession(container)).toBe("session-alpha");
    // The negative control on the projection this surface used to read: it is
    // `undefined` on this very address, so a page fed from it could never see a
    // session at all. Asserted here rather than in a case of its own, because the
    // two readings have to be taken of ONE window for the contrast to hold.
    expect(settingsWindow.frameStore.activeSessionId).toBeUndefined();
  });

  it("hands down nothing in a window that has opened no session", () => {
    const { container } = renderSurface(windowAt("cost").context, sessionEchoPages());
    expect(echoedSession(container)).toBe("no session");
  });

  it("follows the retained session rather than the value it read at mount", () => {
    // The subscription is the claim. A getter read during render answers whatever
    // the store held on that pass and notifies nobody afterwards, so this case
    // fails on a snapshot and passes only on a store subscription.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "workspace", sessionId: "session-beta" });
    });
    expect(echoedSession(container)).toBe("session-beta");
  });

  it("negative control: an unrelated frame change does not rewrite the session", () => {
    // Without this, the case above would pass over a surface that re-read the store
    // on every notification and reported whatever it found — the palette opening is
    // a frame change that says nothing about which session this window is in.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.setPaletteOpen(true);
    });
    expect(echoedSession(container)).toBe("session-alpha");
  });
});
