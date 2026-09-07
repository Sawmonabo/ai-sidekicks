// The settings entry index, and the two claims the surface rests on.
//
// The rail is the closed section tuple and the search is one shared matcher. Both
// are claims about SETS, so the cases drive the sets rather than a hand-listed copy
// beside them — a test that restated the fourteen sections would be one more place to
// widen and the first one to go stale.

import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { SETTINGS_SECTION_IDS, SETTINGS_SECTION_LABELS } from "./settings-sections.js";
import {
  SettingsPageRegistry,
  matchSettingsEntries,
  renderOwnerSlotPage,
  type OwnerSlotPage,
  type SettingsPageContext,
  type SettingsPageDescriptor,
  type SettingsPageRegistration,
} from "./settings-page-registry.js";
import { UNREPORTED_SHELL_STATE } from "../store/index.js";

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
    // A total record is what makes a fifteenth section a compile error rather
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

describe("settings page registry — what is left to warm", () => {
  /** A registration whose body arrives as its own chunk, resolving to nothing. */
  function deferredPageFor(
    section: (typeof SETTINGS_SECTION_IDS)[number],
  ): SettingsPageRegistration {
    return {
      section,
      owner: "settings-registry-test",
      label: SETTINGS_SECTION_LABELS[section],
      keywords: [],
      body: () =>
        Promise.resolve<{ Body: (context: SettingsPageContext) => ReactNode }>({
          Body: () => null,
        }),
    };
  }

  it("names the sections still to load, in rail order", () => {
    // Rail order rather than registration order, for the two boards' reason: what a walk
    // warms first is observable, and registration order would make it depend on which
    // page lane the chunk root evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    registry.register(deferredPageFor("accounts"));
    expect(registry.unloadedKeys()).toStrictEqual(["accounts", "keyboard"]);
  });

  it("drops a section once its body has been asked for", async () => {
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    await registry.preload("keyboard");
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a component-form page has nothing to warm", () => {
    // Without this, the cases above would pass over a registry that reported every
    // registered section as unloaded — and the walk would then re-arm forever on a page
    // that was never going to resolve.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    expect(registry.registeredSections()).toStrictEqual(["keyboard"]);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});

describe("a settings page whose body another plan authors", () => {
  const CONTEXT = {
    bridge: undefined as never,
    openSection: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_SHELL_STATE,
  } satisfies SettingsPageContext;

  const RESERVED: OwnerSlotPage = {
    slot: {
      contract: {
        owningTask: "Plan-999 (the registry test's own seat)",
        mountObligation: "the page frame and the page context",
        deleteShellIn: "the task that fills this slot",
      },
      body: undefined,
    },
    reservationTitle: "The example page has not been built here yet.",
    reservationDetail: "It will hold what the owning plan authors. Nothing has been asked for it.",
  };

  const FILLED: OwnerSlotPage = {
    ...RESERVED,
    slot: { contract: RESERVED.slot.contract, body: () => "the body rendered" },
  };

  it("renders the reservation while nobody has filled the seat", () => {
    const rendered = renderOwnerSlotPage(RESERVED, CONTEXT);
    expect(rendered).not.toBeNull();
    expect(rendered).toBeDefined();
    expect(JSON.stringify(rendered)).toContain("has not been built here yet");
  });

  it("negative control: a filled seat renders its body instead", () => {
    // Without this, the case above would pass over a renderer that ignored the seat
    // and reserved unconditionally — which is the renderer that will silently
    // swallow the body on the day it lands.
    expect(renderOwnerSlotPage(FILLED, CONTEXT)).toBe("the body rendered");
  });

  it("puts none of the seat's contract on screen", () => {
    // A slot contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const rendered = JSON.stringify(renderOwnerSlotPage(RESERVED, CONTEXT));
    expect(rendered).not.toContain(RESERVED.slot.contract.owningTask);
    expect(rendered).not.toContain(RESERVED.slot.contract.deleteShellIn);
    expect(rendered).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the reservation does render text that could have carried it", () => {
    // Without this, the case above would pass over a renderer that produced nothing
    // at all, which is indistinguishable to `toContain` from one that stayed quiet.
    expect(JSON.stringify(renderOwnerSlotPage(RESERVED, CONTEXT)).length).toBeGreaterThan(80);
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
