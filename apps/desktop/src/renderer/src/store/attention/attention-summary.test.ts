// What the attention summary counts as still waiting on a person.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { AttentionSummary } from "@renderer/store/attention/attention-summary.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-1",
    momentId: "moment-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    bannerState: "pending",
    seen: false,
    ...overrides,
  };
}

describe("the fold over one read", () => {
  it("drops a resolved item, because it is not waiting on anybody", () => {
    const summary = new AttentionSummary([
      item({ id: "live" }),
      item({ id: "done", resolvedAt: "2026-01-01T10:05:00.000Z" }),
    ]);
    expect(summary.liveItems.map((live) => live.id)).toStrictEqual(["live"]);
  });
});
