// When the surface opens, and what survives the prefix.
//
// The two rules that would rot silently: `//` is the send router's literal-slash
// escape and must open nothing, and a provider entry keeps its own binding rather
// than borrowing the group's by position.

import { describe, expect, it } from "vitest";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import type { ConsoleCommand } from "../../../console/palette/index.js";
import { composeCatalog, filterCatalog, readDiscoveryPrefix } from "./provider-command-catalog.js";

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

describe("readDiscoveryPrefix", () => {
  it("opens on a leading slash and reports the typed name", () => {
    expect(readDiscoveryPrefix("/comp")).toBe("comp");
  });

  it("opens with an empty prefix on the trigger alone", () => {
    expect(readDiscoveryPrefix("/")).toBe("");
  });

  it("reads only the first word, so arguments do not widen the filter", () => {
    expect(readDiscoveryPrefix("/compact now please")).toBe("compact");
  });

  it("negative control: the literal-slash escape opens nothing", () => {
    expect(readDiscoveryPrefix("//not a command")).toBeUndefined();
  });

  it("negative control: ordinary prose opens nothing", () => {
    expect(readDiscoveryPrefix("please read the file")).toBeUndefined();
  });
});

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
