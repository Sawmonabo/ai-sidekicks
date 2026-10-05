// The page registry, and the one search matcher it shares with the palette.

import { describe, expect, it } from "vitest";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "#renderer/features/settings/settings-page-labels.js";
import {
  SettingsPageRegistry,
  matchSettingsPages,
  type SettingsPageDescriptor,
  type SettingsPageRegistration,
} from "./settings-pages.js";
import type { SettingsPageContext } from "./types.js";
import type { ReactNode } from "react";

function pageFor(
  section: (typeof SETTINGS_PAGE_IDS)[number],
  overrides: Partial<SettingsPageDescriptor> = {},
): SettingsPageDescriptor {
  return {
    section,
    label: SETTINGS_PAGE_LABELS[section],
    keywords: [],
    render: () => null,
    ...overrides,
  };
}

describe("settings page registry — one page per section", () => {
  it("answers in rail order rather than registration order", () => {
    // Rail order is what a person reads; registration order would depend on which page's
    // module the bundler evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    registry.register(pageFor("providers"));
    expect(registry.registeredSections()).toStrictEqual(["providers", "keyboard"]);
    expect(registry.entries().map((entry) => entry.section)).toStrictEqual([
      "providers",
      "keyboard",
    ]);
  });
});

describe("settings page registry — what is left to warm", () => {
  /** A registration whose body arrives as its own chunk, resolving to nothing. */
  function deferredPageFor(section: (typeof SETTINGS_PAGE_IDS)[number]): SettingsPageRegistration {
    return {
      section,
      label: SETTINGS_PAGE_LABELS[section],
      keywords: [],
      body: () =>
        Promise.resolve<{ Body: (context: SettingsPageContext) => ReactNode }>({
          Body: () => null,
        }),
    };
  }

  it("names the sections still to load, in rail order", () => {
    // Rail order rather than registration order: what a walk warms first is observable, and
    // registration order would depend on which page module evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    registry.register(deferredPageFor("providers"));
    expect(registry.unloadedKeys()).toStrictEqual(["providers", "keyboard"]);
  });

  it("drops a section once its body has been asked for", async () => {
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    await registry.preload("keyboard");
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a component-form page has nothing to warm", () => {
    // Without this the cases above would pass over a registry that reported every registered
    // section as unloaded, and the walk would re-arm forever on a page that never resolves.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    expect(registry.registeredSections()).toStrictEqual(["keyboard"]);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});

describe("settings search — one matcher, shared with the palette", () => {
  const entries = [
    pageFor("keyboard", { label: "Keyboard", keywords: ["shortcuts", "chords"] }),
    pageFor("runtime", { label: "Runtime", keywords: ["machines"] }),
  ];

  it("answers every entry for an empty query, and nothing for a query no entry embeds", () => {
    expect(matchSettingsPages(entries, "   ").map((match) => match.descriptor.section)).toContain(
      "keyboard",
    );
    expect(matchSettingsPages(entries, "").length).toBe(entries.length);
    expect(matchSettingsPages(entries, "zzzz")).toStrictEqual([]);
  });

  it("finds an entry by an alias its label does not carry", () => {
    // The reason entries declare aliases at all: "shortcuts" appears nowhere in "Keyboard",
    // and a matcher over labels alone would answer nothing.
    const found = matchSettingsPages(entries, "shortc");
    expect(found.map((match) => match.descriptor.section)).toStrictEqual(["keyboard"]);
    expect(found[0]?.matchedText).toBe("shortcuts");
  });
});
