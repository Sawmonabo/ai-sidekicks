// Only the addressed run's binding reaches the command list: one binding's commands are never
// listed under another binding's address, and where the binding cannot be named nothing is.
import { describe, expect, it } from "vitest";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/commands";

import { selectAddressedBindingGroup } from "./entries.js";

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
  },
];

describe("selectAddressedBindingGroup", () => {
  const CLAUDE_RUN = "019b7a11-1100-740e-8110-d1a4c1150311";
  const CODEX_RUN = "019b7a11-1100-740e-8120-d1a4c1150312";

  /** The same two bindings, each now naming the run it was read under. */
  const RUN_ATTRIBUTED: readonly ProviderCommandBindingGroup[] = [
    { ...GROUPS[0]!, runId: CLAUDE_RUN as ProviderCommandBindingGroup["runId"] },
    { ...GROUPS[1]!, runId: CODEX_RUN as ProviderCommandBindingGroup["runId"] },
  ];

  it("selects the group naming the addressed run", () => {
    // An older Claude run beside a newer Codex one: only the addressed run's binding may reach
    // the list.
    const selected = selectAddressedBindingGroup(RUN_ATTRIBUTED, {
      runId: CODEX_RUN,
      driverName: "codex",
    });

    expect(selected?.binding.driverName).toBe("codex");
  });

  it("falls back to the addressed driver where no group names the run", () => {
    // `runId` is `null` both when no run is live and when several are; the composer's address
    // still names its driver.
    const selected = selectAddressedBindingGroup(GROUPS, {
      runId: CLAUDE_RUN,
      driverName: "claude",
    });

    expect(selected?.binding.driverName).toBe("claude");
  });

  it("selects nothing where two groups share the addressed driver and name no run", () => {
    // A coin flip presented as routing is worse than an absence.
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
});
