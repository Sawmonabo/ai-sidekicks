// What the two sources compose into, and what survives the prefix.
//
// The rule that would rot silently: a provider entry keeps its own binding rather
// than borrowing the group's by position. When the surface opens at all is the
// family's own grammar and is asserted beside it, in `directive-syntax.test.ts`.

import { describe, expect, it } from "vitest";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import type { ConsoleCommand } from "../../../console/palette/index.js";
import {
  composeCatalog,
  filterCatalog,
  selectAddressedBindingGroup,
} from "./provider-command-catalog.js";

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

describe("selectAddressedBindingGroup", () => {
  const CLAUDE_RUN = "019b7a11-1100-740e-8110-d1a4c1150311";
  const CODEX_RUN = "019b7a11-1100-740e-8120-d1a4c1150312";

  /** The same two bindings, each now naming the run it was read under. */
  const RUN_ATTRIBUTED: readonly ProviderCommandBindingGroup[] = [
    { ...GROUPS[0]!, runId: CLAUDE_RUN as ProviderCommandBindingGroup["runId"] },
    { ...GROUPS[1]!, runId: CODEX_RUN as ProviderCommandBindingGroup["runId"] },
  ];

  it("selects the group naming the addressed run", () => {
    // The finding: an older Claude run beside a newer Codex one. Only the addressed
    // run's binding may reach the list.
    const selected = selectAddressedBindingGroup(RUN_ATTRIBUTED, {
      runId: CODEX_RUN,
      driverName: "codex",
    });

    expect(selected?.binding.driverName).toBe("codex");
  });

  it("falls back to the addressed driver where no group names the run", () => {
    // `runId` is `null` on two legitimate arms — no live run, and two or more on one
    // binding — and the composer's own address still names the driver it is bound to.
    const selected = selectAddressedBindingGroup(GROUPS, {
      runId: CLAUDE_RUN,
      driverName: "claude",
    });

    expect(selected?.binding.driverName).toBe("claude");
  });

  it("selects nothing where two groups share the addressed driver and name no run", () => {
    // A coin flip presented as routing is worse than an absence: the surface renders
    // the absence and offers neither binding's entries.
    const sameDriver: readonly ProviderCommandBindingGroup[] = [
      GROUPS[0]!,
      { ...GROUPS[1]!, binding: { driverName: "claude", providerAccountId: "account-1" } },
    ];

    expect(
      selectAddressedBindingGroup(sameDriver, { runId: CLAUDE_RUN, driverName: "claude" }),
    ).toBeUndefined();
  });

  it("selects nothing where the composer names neither a run nor a driver", () => {
    expect(
      selectAddressedBindingGroup(GROUPS, { runId: undefined, driverName: undefined }),
    ).toBeUndefined();
  });

  it("negative control: composing the selected group alone drops the sibling's entries", () => {
    // Without the selection every group reached `composeCatalog`, which is exactly
    // what put one binding's commands under another binding's address.
    const merged = composeCatalog({ offeredCommands: OFFERED, providerGroups: RUN_ATTRIBUTED });
    const selected = selectAddressedBindingGroup(RUN_ATTRIBUTED, {
      runId: CODEX_RUN,
      driverName: "codex",
    });
    const scoped = composeCatalog({
      offeredCommands: OFFERED,
      providerGroups: selected === undefined ? [] : [selected],
    });

    expect(merged.filter((entry) => entry.source === "provider")).toHaveLength(2);
    expect(scoped.filter((entry) => entry.source === "provider")).toHaveLength(1);
  });
});
