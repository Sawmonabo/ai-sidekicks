// The count on the rail is the number of sessions waiting on a person, read off the summary's
// actionable split.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { AttentionSummary } from "./summary.js";
import { attentionCountOf } from "./count.js";

// The two sessions the items here belong to.
const SESSION_A = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a01");
const SESSION_B = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a02");

function attentionItem(overrides: Partial<AttentionItem> & { readonly id: string }): AttentionItem {
  return {
    sessionId: SESSION_A,
    trigger: "pending_approval",
    severity: "actionable",
    summary: "waiting",
    sourceEventId: `event-${overrides.id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  } as AttentionItem;
}

/** The sessions the fan-out asked about. The rail counts the answer, not the ask. */
const ADDRESSED_SESSION_IDS: readonly string[] = [SESSION_A, SESSION_B];

describe("attentionCountOf", () => {
  it("counts the sessions with actionable attention, not the items", () => {
    const summary = new AttentionSummary([
      attentionItem({ id: "1", sessionId: SESSION_A }),
      attentionItem({ id: "2", sessionId: SESSION_A }),
      attentionItem({ id: "3", sessionId: SESSION_B }),
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
      attentionItem({ id: "1", sessionId: SESSION_A }),
      attentionItem({ id: "2", sessionId: SESSION_B, severity: "informational" }),
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
