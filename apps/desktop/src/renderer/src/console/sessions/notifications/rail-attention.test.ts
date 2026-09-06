// What the rail is told, and the three readings that tell it nothing.
//
// The count's whole value is that it is trustworthy: a number on the console's
// most-seen surface that could be left over from a read that failed would be worse
// than no number at all. So every arm of the reading is asserted, and the zero case is
// asserted to be an absence rather than a zero.

import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../../bridge/index.js";
import { refuse } from "../../core/index.js";
import { AttentionPlane } from "./attention-plane.js";
import { railAttentionCountOf } from "./rail-attention.js";

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

describe("railAttentionCountOf", () => {
  it("counts the sessions with actionable attention, not the items", () => {
    const plane = new AttentionPlane([
      attentionItem({ id: "1", sessionId: "session-a" }),
      attentionItem({ id: "2", sessionId: "session-a" }),
      attentionItem({ id: "3", sessionId: "session-b" }),
    ]);
    expect(
      railAttentionCountOf({ phase: "read", plane, droppedCount: 0, refusedSessions: [] }),
    ).toBe(2);
  });

  it("does not count a session whose attention is informational only", () => {
    const plane = new AttentionPlane([
      attentionItem({ id: "1", sessionId: "session-a" }),
      attentionItem({ id: "2", sessionId: "session-b", severity: "informational" }),
    ]);
    expect(
      railAttentionCountOf({ phase: "read", plane, droppedCount: 0, refusedSessions: [] }),
    ).toBe(1);
  });

  it("answers undefined rather than zero when nothing is waiting", () => {
    // The rail's quietest state is the common one, and a badge reading `0` on it
    // would be permanent furniture reporting the absence of news.
    const plane = new AttentionPlane([]);
    expect(
      railAttentionCountOf({ phase: "read", plane, droppedCount: 0, refusedSessions: [] }),
    ).toBeUndefined();
  });

  it("suppresses the count on every reading that is not an answer", () => {
    // The suppression rule: while the projection is unreachable the rail says nothing
    // rather than the number from before.
    expect(railAttentionCountOf({ phase: "reading" })).toBeUndefined();
    expect(railAttentionCountOf({ phase: "not-asked" })).toBeUndefined();
    expect(
      railAttentionCountOf({
        phase: "refused",
        refusal: refuse("attention-plane", "read-failed", "nothing came back"),
      }),
    ).toBeUndefined();
  });
});
