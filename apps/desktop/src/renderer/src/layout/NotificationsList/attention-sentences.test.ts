// One settled read, one sentence — and the wordings that must not blur together.
//
// Every case here is really the same assertion from a different side: a person who
// hears this sentence and cannot see the panel must be able to tell a read that found
// nothing from a read that covered less than it was asked to. The two shapes that
// would break that are a zero left silent when coverage was incomplete, and a
// coverage gap left out of a sentence that reported a count.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { refuse } from "@renderer/lib/refusal.js";
import {
  AttentionSummary,
  type RefusedAttentionSession,
} from "@renderer/store/attention/attention-summary.js";
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
    // The sentence is composed from what the read FOUND and from how much of it went
    // unanswered, so the address set names the sessions and decides nothing here.
    addressedSessionIds: ["s-1", "s-2"],
  };
}

describe("what one settled attention read says", () => {
  it("counts what needs a person, in the singular and the plural", () => {
    expect(describeAttentionSettlement(answered({ items: [itemNeeding("a")] }))).toBe(
      "One item needs you.",
    );
    expect(
      describeAttentionSettlement(answered({ items: [itemNeeding("a"), itemNeeding("b")] })),
    ).toBe("2 items need you.");
  });

  it("stays silent only for a read that found nothing and covered everything", () => {
    // The whole point of the zero wording. A read that answered for every session
    // and dropped nothing has nothing to say; anything less does, and the sentence has
    // to carry that difference on its own because nobody hearing it can see the panel.
    expect(describeAttentionSettlement(answered({}))).toBeUndefined();
    expect(
      describeAttentionSettlement(answered({ refusedSessions: [refusedSession("s-1")] })),
    ).toBe("Nothing was found in what this read covered. One session could not be checked.");
    expect(describeAttentionSettlement(answered({ droppedCount: 1 }))).toBe(
      "Nothing was found in what this read covered. 1 delivery could not be read, so what needs you may be behind what the background service has sent.",
    );
  });

  it("carries the coverage gap beside a count rather than instead of it", () => {
    expect(
      describeAttentionSettlement(
        answered({
          items: [itemNeeding("a")],
          refusedSessions: [refusedSession("s-1"), refusedSession("s-2")],
        }),
      ),
    ).toBe("One item needs you. 2 sessions could not be checked.");
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
    ).toBe(
      "2 items need you. One session could not be checked. 2 deliveries could not be read, so what needs you may be behind what the background service has sent.",
    );
  });
});
