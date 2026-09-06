// One settled read, one sentence — and the wordings that must not blur together.
//
// Every case here is really the same assertion from a different side: a person who
// hears this sentence and cannot see the panel must be able to tell an all-clear
// from a read that covered less than it was asked to. The two shapes that would
// break that are a zero worded as freedom when coverage was incomplete, and a
// coverage gap left out of a sentence that reported a count.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import { AttentionPlane } from "./attention-plane.js";
import {
  narrowAttentionProjection,
  type RefusedAttentionSession,
} from "./attention-projection-read.js";
import { describeAttentionSettlement } from "./attention-sentences.js";

const CREATED_AT = "2026-01-01T10:00:00.000Z";

/** One live item, built the way the projection would hand it over. */
function itemNeeding(id: string): Record<string, unknown> {
  return {
    id,
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: `event-${id}`,
    createdAt: CREATED_AT,
  };
}

/** One session the fan-out never got an answer for. */
function refusedSession(sessionId: string): RefusedAttentionSession {
  return { sessionId, refusal: growthUnavailable("attentionProjectionRead") };
}

/** A settled read that answered, with whatever coverage a case names. */
function answered(options: {
  readonly items?: readonly Record<string, unknown>[];
  readonly refusedSessions?: readonly RefusedAttentionSession[];
  readonly droppedCount?: number;
}): Parameters<typeof describeAttentionSettlement>[0] {
  return {
    phase: "read",
    // Through the real boundary rather than cast past it: a case that hand-built an
    // item the narrowing would have dropped would be describing a plane this console
    // cannot actually produce.
    plane: new AttentionPlane(narrowAttentionProjection(options.items ?? []).items),
    droppedCount: options.droppedCount ?? 0,
    refusedSessions: options.refusedSessions ?? [],
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

  it("says the all-clear only for a read that covered everything", () => {
    // The whole point of the zero wording. A read that answered for every session
    // and dropped nothing is freedom; anything less is not, and the sentence has to
    // carry that difference on its own because nobody hearing it can see the panel.
    expect(describeAttentionSettlement(answered({}))).toBe("Nothing needs you.");
    expect(
      describeAttentionSettlement(answered({ refusedSessions: [refusedSession("s-1")] })),
    ).toBe("Nothing was found in what this read covered. One session could not be checked.");
    expect(describeAttentionSettlement(answered({ droppedCount: 1 }))).toBe(
      "Nothing was found in what this read covered. 1 delivery could not be read, so what needs you may be behind what the daemon has sent.",
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
      "2 items need you. One session could not be checked. 2 deliveries could not be read, so what needs you may be behind what the daemon has sent.",
    );
  });

  it("speaks a refusal in the port's own words and never its code", () => {
    const refusal = growthUnavailable("attentionProjectionRead");
    const spoken = describeAttentionSettlement({ phase: "refused", refusal });

    expect(spoken).toBe(refusal.detail);
    // Read aloud a code is a token nobody can act on, ahead of the sentence that
    // matters. It stays on screen, where it can be copied.
    expect(spoken).not.toContain(refusal.code);
  });

  it("does not let a question nobody put sound like an answer", () => {
    // The installed bridge settles here and stays. Silence would leave a person
    // hearing nothing at all, which is indistinguishable from the all-clear.
    expect(describeAttentionSettlement({ phase: "not-asked" })).toBe(
      "The attention projection has not been read, so this is not an all-clear.",
    );
  });
});
