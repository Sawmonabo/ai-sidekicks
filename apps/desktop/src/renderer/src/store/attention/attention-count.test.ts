// The count on the rail is the number of sessions waiting on a person, read off the summary's
// actionable split.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { AttentionSummary } from "./attention-summary.js";
import { attentionCountOf } from "./attention-count.js";

function attentionItem(overrides: Partial<AttentionItem> & { readonly id: string }): AttentionItem {
  return {
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "waiting",
    sourceEventId: `event-${overrides.id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  } as AttentionItem;
}

/** The sessions the fan-out asked about. The rail counts the answer, not the ask. */
const ADDRESSED_SESSION_IDS: readonly string[] = ["session-a", "session-b"];

describe("attentionCountOf", () => {
  it("counts the sessions with actionable attention, not the items", () => {
    const summary = new AttentionSummary([
      attentionItem({ id: "1", sessionId: "session-a" }),
      attentionItem({ id: "2", sessionId: "session-a" }),
      attentionItem({ id: "3", sessionId: "session-b" }),
    ]);
    expect(
      attentionCountOf({
        phase: "read",
        summary,
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: ADDRESSED_SESSION_IDS,
      }),
    ).toBe(2);
  });

  it("does not count a session whose attention is informational only", () => {
    const summary = new AttentionSummary([
      attentionItem({ id: "1", sessionId: "session-a" }),
      attentionItem({ id: "2", sessionId: "session-b", severity: "informational" }),
    ]);
    expect(
      attentionCountOf({
        phase: "read",
        summary,
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: ADDRESSED_SESSION_IDS,
      }),
    ).toBe(1);
  });
});
