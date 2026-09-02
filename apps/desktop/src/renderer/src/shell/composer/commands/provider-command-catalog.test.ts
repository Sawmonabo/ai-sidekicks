// What the two sources compose into, and what survives the prefix.
//
// The rule that would rot silently: a provider entry keeps its own binding rather
// than borrowing the group's by position. When the surface opens at all is the
// family's own grammar and is asserted beside it, in `directive-syntax.test.ts`.

import { describe, expect, it } from "vitest";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import type { ConsoleCommand } from "../../../console/palette/index.js";
import { composeCatalog, filterCatalog } from "./provider-command-catalog.js";

const OFFERED: readonly ConsoleCommand[] = [
  { id: "frame.goToSettings", title: "Go to Settings", group: "Navigate", run: () => undefined },
];

const GROUPS: readonly ProviderCommandBindingGroup[] = [
  {
    runId: null,
    binding: { driverName: "claude", providerAccountId: null },
    entries: [
      {
        name: "compact",
        kind: "command",
        description: "Compact the conversation context.",
        binding: { driverName: "claude", providerAccountId: null },
      },
    ],
    complete: true,
  },
  {
    runId: null,
    binding: { driverName: "codex", providerAccountId: "account-1" },
    entries: [
      {
        name: "compact",
        kind: "command",
        binding: { driverName: "codex", providerAccountId: "account-1" },
      },
    ],
    complete: true,
  },
];

describe("composeCatalog", () => {
  it("carries each provider entry's own binding rather than a shared one", () => {
    const catalog = composeCatalog({ offeredCommands: [], providerGroups: GROUPS });

    expect(catalog).toHaveLength(2);
    expect(catalog.map((entry) => (entry.source === "provider" ? entry.driverName : ""))).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("negative control: two bindings publishing one name stay two rows", () => {
    const catalog = composeCatalog({ offeredCommands: [], providerGroups: GROUPS });

    expect(new Set(catalog.map((entry) => entry.key)).size).toBe(2);
  });

  it("leaves a provider-published description absent rather than inventing one", () => {
    const catalog = composeCatalog({ offeredCommands: [], providerGroups: [GROUPS[1]!] });

    expect(catalog[0]?.description).toBeUndefined();
  });

  it("offers console acts with the command id a person types", () => {
    const catalog = composeCatalog({ offeredCommands: OFFERED, providerGroups: [] });

    expect(catalog[0]).toMatchObject({ source: "console", name: "frame.goToSettings" });
  });
});

describe("filterCatalog", () => {
  it("keeps only entries whose name begins with what has been typed", () => {
    const catalog = composeCatalog({ offeredCommands: OFFERED, providerGroups: GROUPS });

    expect(filterCatalog(catalog, "comp").map((entry) => entry.name)).toEqual([
      "compact",
      "compact",
    ]);
  });

  it("negative control: a mid-name match is not a prefix match", () => {
    const catalog = composeCatalog({ offeredCommands: OFFERED, providerGroups: GROUPS });

    expect(filterCatalog(catalog, "pact")).toHaveLength(0);
  });

  it("returns everything on the trigger alone", () => {
    const catalog = composeCatalog({ offeredCommands: OFFERED, providerGroups: GROUPS });

    expect(filterCatalog(catalog, "")).toHaveLength(3);
  });
});
