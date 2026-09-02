// The three rules the settings surface is the enforcement of.
//
// Two of them are invisible to the type system and would go wrong quietly: a rail
// that shrinks when a wire is unavailable teaches a person the setting does not
// exist, and a pane that swallows an unknown address leaves a bad deep link looking
// like a working one. The third — that the open section lives in the route and not
// in a local — is what makes a deep link and a rail click the same act.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "../primitives/index.js";
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

/** The three fields this surface reads, and nothing else. */
function contextFor(
  page: string | undefined,
  navigate: (route: unknown) => void = () => undefined,
): ConsoleSurfaceContext {
  return {
    route: { kind: "settings", page },
    bridge: { source: "fixture" },
    frameStore: { navigate },
  } as unknown as ConsoleSurfaceContext;
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
    const navigate = vi.fn();
    const { container } = renderSurface(contextFor(undefined, navigate));
    const entry = container.querySelector(".meridian-settings__section");
    (entry as HTMLButtonElement | null)?.click();
    expect(navigate).toHaveBeenCalledWith({ kind: "settings", page: SETTINGS_SECTION_IDS[0] });
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
