// One settled read, one sentence. A person hearing it without seeing the panel must tell a read
// that found nothing from one that covered less than asked: a zero must not be silent when coverage
// was incomplete, and a coverage gap must not be left out of a counted sentence.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { refuse } from "#renderer/lib/refusal/contract.js";
import {
  AttentionSummary,
  type RefusedAttentionSession,
} from "#renderer/store/attention/summary.js";
import { describeAttentionSettlement } from "./attention-sentences.js";

const CREATED_AT = "2026-01-01T10:00:00.000Z";

/** One live item, built the way the projection would hand it over. */
function itemNeeding(id: string): AttentionItem {
  return {
    id,
    momentId: "moment-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
    sourceEventId: `event-${id}`,
    createdAt: CREATED_AT,
    bannerState: "pending",
    seen: false,
  };
}

/** One session the fan-out never got an answer for. */
function refusedSession(sessionId: string): RefusedAttentionSession {
  return {
    sessionId,
    refusal: refuse(
      "attention-projection",
      "session.not_found",
      "That session is not known to the daemon.",
    ),
  };
}

/** A settled read that answered, with whatever coverage a case names. */
function answered(options: {
  readonly items?: readonly AttentionItem[];
  readonly refusedSessions?: readonly RefusedAttentionSession[];
  readonly droppedCount?: number;
}): Parameters<typeof describeAttentionSettlement>[0] {
  return {
    phase: "read",
    summary: new AttentionSummary(options.items ?? []),
    droppedCount: options.droppedCount ?? 0,
    refusedSessions: options.refusedSessions ?? [],
    // The sentence uses what the read found and how much went unanswered; the address set only
    // names sessions.
    addressedSessionIds: ["s-1", "s-2"],
  };
}

describe("what one settled attention read says", () => {
  it("stays silent only for a read that found nothing and covered everything", () => {
    // A read that answered for every session and dropped nothing has nothing to say; anything less
    // must say so, since a listener cannot see the panel.
    expect(describeAttentionSettlement(answered({}))).toBeUndefined();
    expect(
      describeAttentionSettlement(answered({ refusedSessions: [refusedSession("s-1")] })),
    ).toBe("Nothing was found in what this read covered. One session could not be checked.");
    expect(describeAttentionSettlement(answered({ droppedCount: 1 }))).toBe(
      "Nothing was found in what this read covered. 1 delivery could not be read.",
    );
  });

  it("states every fact the read produced, in one sentence", () => {
    expect(
      describeAttentionSettlement(
        answered({
          items: [itemNeeding("a"), itemNeeding("b")],
          refusedSessions: [refusedSession("s-1")],
          droppedCount: 2,
        }),
      ),
    ).toBe("2 items need you. One session could not be checked. 2 deliveries could not be read.");
  });
});
