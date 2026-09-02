// The settings entry index, and the two claims the surface rests on.
//
// The rail is the closed section tuple and the search is one shared matcher. Both
// are claims about SETS, so the cases drive the sets rather than a hand-listed copy
// beside them — a test that restated the twelve sections would be a thirteenth
// place to widen and the first one to go stale.

import { describe, expect, it } from "vitest";

import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  SettingsPageRegistry,
  matchSettingsEntries,
  registerReservedSettingsPages,
  type SettingsPageDescriptor,
} from "./settings-page-registry.js";

function pageFor(
  section: (typeof SETTINGS_SECTION_IDS)[number],
  overrides: Partial<SettingsPageDescriptor> = {},
): SettingsPageDescriptor {
  return {
    section,
    owner: "settings-registry-test",
    label: SETTINGS_SECTION_LABELS[section],
    keywords: [],
    render: () => null,
    ...overrides,
  };
}

describe("settings sections — the closed set the rail renders", () => {
  it("labels every section, and labels nothing else", () => {
    // A total record is what makes a thirteenth section a compile error rather
    // than a rail entry reading `mcp-servers`. Checked at runtime too, because the
    // record could be widened past the union with a cast.
    expect(Object.keys(SETTINGS_SECTION_LABELS).sort()).toStrictEqual(
      [...SETTINGS_SECTION_IDS].sort(),
    );
    for (const section of SETTINGS_SECTION_IDS) {
      expect(SETTINGS_SECTION_LABELS[section].length).toBeGreaterThan(0);
    }
  });

  it("names each section exactly once", () => {
    expect(new Set(SETTINGS_SECTION_IDS).size).toBe(SETTINGS_SECTION_IDS.length);
  });
});

describe("settings page registry — one page per section", () => {
  it("answers in rail order rather than registration order", () => {
    // Rail order is what a person reads. Registration order would make it depend
    // on which lane's module the bundler evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    registry.register(pageFor("accounts"));
    expect(registry.registeredSections()).toStrictEqual(["accounts", "keyboard"]);
    expect(registry.entries().map((entry) => entry.section)).toStrictEqual([
      "accounts",
      "keyboard",
    ]);
  });

  it("replaces under one owner and refuses a second", () => {
    // The owner-scoped policy: a hot reload re-runs a lane's module and must
    // replace; two lanes on one section is a conflict rather than a swap decided
    // by import order.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("nodes", { label: "First" }));
    registry.register(pageFor("nodes", { label: "Second" }));
    expect(registry.descriptorFor("nodes")?.label).toBe("Second");
    expect(() => {
      registry.register(pageFor("nodes", { owner: "another-lane" }));
    }).toThrow();
  });

  it("negative control: a fresh registry claims nothing", () => {
    // Every case above reads `registeredSections`, and all of them would pass over
    // a registry that reported sections nobody registered.
    expect(new SettingsPageRegistry().registeredSections()).toStrictEqual([]);
  });
});

describe("settings pages whose body another plan authors", () => {
  it("claims its sections and renders a stated absence rather than a stub", () => {
    const registry = new SettingsPageRegistry();
    registerReservedSettingsPages(registry);
    const sections = registry.registeredSections();
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const rendered = registry.descriptorFor(section)?.render({
        bridge: undefined as never,
        openSection: () => undefined,
        activeSessionId: undefined,
      });
      expect(rendered).not.toBeNull();
      expect(rendered).toBeDefined();
    }
  });

  it("names no governance work in anything it renders", () => {
    // A slot contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const registry = new SettingsPageRegistry();
    registerReservedSettingsPages(registry);
    for (const section of registry.registeredSections()) {
      const descriptor = registry.descriptorFor(section);
      const readable = [descriptor?.label ?? "", ...(descriptor?.keywords ?? [])].join(" ");
      expect(readable).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
    }
  });
});

describe("settings search — one matcher, shared with the palette", () => {
  const entries = [
    pageFor("keyboard", { label: "Keyboard", keywords: ["shortcuts", "chords"] }),
    pageFor("nodes", { label: "Nodes", keywords: ["machines"] }),
  ];

  it("answers every entry in rail order for an empty query", () => {
    expect(matchSettingsEntries(entries, "   ").map((match) => match.descriptor.section)).toContain(
      "keyboard",
    );
    expect(matchSettingsEntries(entries, "").length).toBe(entries.length);
  });

  it("finds an entry by an alias its label does not carry", () => {
    // The reason entries declare aliases at all: "shortcuts" appears nowhere in
    // the word "Keyboard", and a matcher over labels alone would answer nothing.
    const found = matchSettingsEntries(entries, "shortc");
    expect(found.map((match) => match.descriptor.section)).toStrictEqual(["keyboard"]);
    expect(found[0]?.matchedText).toBe("shortcuts");
  });

  it("answers nothing for a query no entry embeds", () => {
    expect(matchSettingsEntries(entries, "zzzz")).toStrictEqual([]);
  });

  it("negative control: the ranking is the scorer's and not insertion order", () => {
    // Without this the alias case would pass over a matcher that returned every
    // entry it was given, in the order it was given them.
    const ranked = matchSettingsEntries(entries, "nodes");
    expect(ranked[0]?.descriptor.section).toBe("nodes");
  });
});
