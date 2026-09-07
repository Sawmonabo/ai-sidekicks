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
//
// WHEN THIS SURFACE'S DEFERRED PAGES ARE FETCHED is a fifth claim and is not here: it is
// about a board rather than about what the rail and the pane render, and it needs the idle
// host pinned, which none of the four below wants. `SettingsSurface.page-warm.test.tsx`
// holds it, and the window, the mount, and the keystroke both suites drive are hoisted
// into `SettingsSurface.test-support.tsx`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsPageRegistry } from "./settings-page-registry.js";
import { SETTINGS_SECTION_IDS } from "./settings-sections.js";
import { renderSurface, searchFor, windowAt } from "./SettingsSurface.test-support.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

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

/** The four fields this surface reads, and nothing else. */
function contextFor(page: string | undefined): ConsoleSurfaceContext {
  return windowAt(page).context;
}

function railLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-settings__section")].map(
    (element) => element.textContent ?? "",
  );
}

describe("settings rail — every section, always", () => {
  it("renders one entry per declared section", async () => {
    // The claim is about a SET, so the case drives the set. A rail assembled from
    // the registry instead would shrink to whatever has been built, which is the
    // "never hides an entry because its wire is unavailable" rule inverted.
    const { container } = await renderSurface(contextFor(undefined));
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });

  it("marks the section the address names, and only that one", async () => {
    const { container } = await renderSurface(contextFor("keyboard"));
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Keyboard");
  });

  it("negative control: an address naming no section marks nothing", async () => {
    // Without this, the case above would pass over a rail that marked its first
    // entry whenever nothing else was selected — which would make `#/settings`
    // look like a section had been chosen.
    const { container } = await renderSurface(contextFor(undefined));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it("navigates rather than holding the selection in a local", async () => {
    // The open section lives in the route. A local would make a rail click and a
    // deep link two different acts, and the back button would stop working.
    const settingsWindow = windowAt(undefined);
    const { container } = await renderSurface(settingsWindow.context);
    const entry = container.querySelector(".meridian-settings__section");
    (entry as HTMLButtonElement | null)?.click();
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: SETTINGS_SECTION_IDS[0],
    });
  });
});

describe("settings pane — the three ways there is no page", () => {
  it("invites a choice when the address names none", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    expect(container.textContent ?? "").toContain("Choose a section.");
  });

  it("names an address it does not recognise back to the reader", async () => {
    const { container } = await renderSurface(contextFor("not-a-section"));
    const text = container.textContent ?? "";
    expect(text).toContain("not-a-section");
    expect(text).toContain("does not name a section");
  });

  it("says a section's page is reserved rather than drawing an empty pane", async () => {
    // An EMPTY registry rather than the shipped one. The claim is the pane's — a
    // section whose page nobody registered says so — and pinning it to whichever
    // section happens to be unbuilt this week made it fail the moment that
    // section's lane landed, which is a stale test rather than a real regression.
    const { container } = await renderSurface(contextFor("keyboard"), new SettingsPageRegistry());
    expect(container.textContent ?? "").toContain("has not been built yet");
  });

  it("renders a registered page instead of the reservation", async () => {
    // Negative control for the case above: it would pass over a pane that rendered
    // the reservation for every section, registered or not. `mcp-servers` carries a
    // page in this build — its body is another plan's, but the PAGE is registered.
    const { container } = await renderSurface(contextFor("mcp-servers"));
    expect(container.textContent ?? "").toContain("MCP server page");
  });
});

describe("settings search — one field above the rail", () => {
  it("replaces the rail with ranked hits while a query stands", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    expect(railLabels(container).length).toBeLessThan(SETTINGS_SECTION_IDS.length);
    expect(container.textContent ?? "").toContain("MCP servers");
  });

  it("names the query and what was searched when nothing matches", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "zzzzq");
    const text = container.textContent ?? "";
    expect(text).toContain("zzzzq");
    expect(text).toContain("Every section was searched");
  });

  it("negative control: clearing the query restores every section", async () => {
    // Without this, the first case would pass over a surface that filtered the rail
    // permanently on the first keystroke.
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    searchFor(container, "");
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });
});

describe("the session a settings page is handed", () => {
  it("hands down the session this window opened, on an address that names none", async () => {
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    expect(echoedSession(container)).toBe("session-alpha");
    // The negative control on the projection this surface used to read: it is
    // `undefined` on this very address, so a page fed from it could never see a
    // session at all. Asserted here rather than in a case of its own, because the
    // two readings have to be taken of ONE window for the contrast to hold.
    expect(settingsWindow.frameStore.activeSessionId).toBeUndefined();
  });

  it("hands down nothing in a window that has opened no session", async () => {
    const { container } = await renderSurface(windowAt("cost").context, sessionEchoPages());
    expect(echoedSession(container)).toBe("no session");
  });

  it("follows the retained session rather than the value it read at mount", async () => {
    // The subscription is the claim. A getter read during render answers whatever
    // the store held on that pass and notifies nobody afterwards, so this case
    // fails on a snapshot and passes only on a store subscription.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "workspace", sessionId: "session-beta" });
    });
    expect(echoedSession(container)).toBe("session-beta");
  });

  it("negative control: an unrelated frame change does not rewrite the session", async () => {
    // Without this, the case above would pass over a surface that re-read the store
    // on every notification and reported whatever it found — the palette opening is
    // a frame change that says nothing about which session this window is in.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.setPaletteOpen(true);
    });
    expect(echoedSession(container)).toBe("session-alpha");
  });
});
