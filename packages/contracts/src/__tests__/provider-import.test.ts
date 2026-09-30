// The provider-session import's stream: the running count, and each way an
// import can end.
import { describe, expect, it } from "vitest";

import {
  ProviderImportProgressSchema,
  ProviderImportStopRequestSchema,
} from "../provider-import.js";

const IMPORT_ID = "import_01J8XYZ";

function settled(settlement: Record<string, unknown>): boolean {
  return ProviderImportProgressSchema.safeParse({
    kind: "settled",
    provider: "claude",
    importId: IMPORT_ID,
    settlement,
  }).success;
}

describe("session.importSubscribe", () => {
  it("reports the running count and each way an import ends", () => {
    expect(
      ProviderImportProgressSchema.safeParse({
        kind: "progress",
        provider: "codex",
        importId: IMPORT_ID,
        read: 128,
      }).success,
    ).toBe(true);
    expect(
      settled({
        outcome: "finished",
        imported: 125,
        total: 128,
        alreadyHere: 34,
        failures: [{ source: "/Users/person/.codex/sessions/a.jsonl", reason: "Truncated file." }],
        unreadableFiles: ["/Users/person/.codex/sessions/b.jsonl"],
        attachedProjects: ["web-app"],
      }),
    ).toBe(true);
    expect(settled({ outcome: "nothingNew", alreadyHere: 34, unreadableFiles: [] })).toBe(true);
    expect(settled({ outcome: "stopped" })).toBe(true);
    expect(
      settled({ outcome: "refused", reason: "Claude Code's session folder is missing." }),
    ).toBe(true);
  });

  it("gives each failure its reason and a refusal its words", () => {
    expect(
      settled({
        outcome: "finished",
        imported: 1,
        total: 2,
        alreadyHere: 0,
        failures: [{ source: "/Users/person/.claude/projects/x/a.jsonl" }],
        unreadableFiles: [],
        attachedProjects: [],
      }),
    ).toBe(false);
    expect(settled({ outcome: "refused" })).toBe(false);
    expect(settled({ outcome: "cancelled" })).toBe(false);
  });

  it("stops an import by its id", () => {
    expect(ProviderImportStopRequestSchema.safeParse({ importId: IMPORT_ID }).success).toBe(true);
    expect(ProviderImportStopRequestSchema.safeParse({ provider: "claude" }).success).toBe(false);
  });
});
