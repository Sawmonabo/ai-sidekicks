// The sidekicks registration: the rail reaches the agents family's page.
//
// The claim under test is a SEAM, not a body — the page's own contents are asserted
// beside the page, in the agents family. What can only be checked here is that the
// section is claimed, that a person's words find it, and that the thing rendered is
// the real page rather than a stand-in this file drew.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { registerSidekicksPage } from "./sidekicks-page.js";
import {
  SETTINGS_SECTION_IDS,
  SettingsPageRegistry,
  matchSettingsEntries,
  type SettingsPageContext,
} from "../settings-page-registry.js";

/** The body takes no props, so the context it is handed is never read. */
const CONTEXT = {
  bridge: { source: "fixture" },
  openSection: () => undefined,
  activeSessionId: undefined,
} as unknown as SettingsPageContext;

function registeredRegistry(): SettingsPageRegistry {
  const registry = new SettingsPageRegistry();
  registerSidekicksPage(registry);
  return registry;
}

describe("the sidekicks settings page", () => {
  it("claims a section the rail actually renders", () => {
    // Both halves matter: a descriptor under an id outside the tuple would register
    // and never appear, and an id in the tuple with no descriptor is a blank pane.
    expect(SETTINGS_SECTION_IDS).toContain("sidekicks");
    expect(registeredRegistry().registeredSections()).toStrictEqual(["sidekicks"]);
  });

  it("renders the agents family's page and not a local stand-in", () => {
    // The page's own heading and its first standing fact, which only the real body
    // carries. A shell drawn here would pass an "it rendered something" assertion.
    const descriptor = registeredRegistry().descriptorFor("sidekicks");
    expect(descriptor).toBeDefined();
    const { container } = render(<>{descriptor?.render(CONTEXT)}</>);
    expect(container.querySelector(".meridian-sidekicks__title")?.textContent).toBe("Sidekicks");
    expect(container.textContent ?? "").toContain("Where they live");
  });

  it("is found by the words a person types for it", () => {
    const entries = registeredRegistry().entries();
    for (const query of ["sidekick", "definitions", "presets", "tools"]) {
      expect(
        matchSettingsEntries(entries, query).map((match) => match.descriptor.section),
      ).toStrictEqual(["sidekicks"]);
    }
  });

  it("negative control: the search does not answer with it for unrelated words", () => {
    // Without this, a matcher that answered every entry for every query would pass
    // the case above and tell a person nothing.
    expect(matchSettingsEntries(registeredRegistry().entries(), "zzzz")).toStrictEqual([]);
  });

  it("negative control: a second owner claiming the section is an error", () => {
    // Two lanes on one section is a conflict rather than a swap decided by import
    // order, and this registration is the newest claimant on the newest id.
    const registry = registeredRegistry();
    expect(() => {
      registry.register({
        section: "sidekicks",
        owner: "some-other-lane",
        label: "Sidekicks",
        keywords: [],
        render: () => null,
      });
    }).toThrow();
  });
});
