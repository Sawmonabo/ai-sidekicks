// The count must be trustworthy: every arm of the reading is asserted, and zero is asserted
// to be an absence rather than a zero.

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

  it("answers undefined rather than zero when nothing is waiting", () => {
    // A "0" badge on the rail's quietest state would be permanent furniture.
    const summary = new AttentionSummary([]);
    expect(
      attentionCountOf({
        phase: "read",
        summary,
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: ADDRESSED_SESSION_IDS,
      }),
    ).toBeUndefined();
  });

  it("suppresses the count while the read is in flight", () => {
    // Until the projection answers, the rail says nothing rather than the number from before.
    expect(attentionCountOf({ phase: "reading" })).toBeUndefined();
  });
});
