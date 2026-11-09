// The count on the rail is the number of sessions waiting on a person, read off the summary's
// actionable split.

import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionMomentTrigger } from "@ai-sidekicks/contracts/attention";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { providerBuildItem } from "./provider-build.test-support.js";
import { AttentionSummary } from "./summary.js";
import { attentionCountOf } from "./count.js";

// The two sessions the items here belong to.
const SESSION_A = "019b7892-1a00-7c31-8110-cca0117a0a01" as SessionId;
const SESSION_B = "019b7892-1a00-7c31-8110-cca0117a0a02" as SessionId;

/** An entry about a run's or a session's own moment. */
type MomentAttentionItem = Extract<AttentionItem, { readonly trigger: AttentionMomentTrigger }>;

function attentionItem(
  overrides: Partial<MomentAttentionItem> & { readonly id: string },
): MomentAttentionItem {
  return {
    momentId: `moment-${overrides.id}`,
    sessionId: SESSION_A,
    trigger: "pendingApproval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    sourceEventId: `event-${overrides.id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    seen: false,
    ...overrides,
  };
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

  it("adds nothing for a provider's new build, which belongs to no session", () => {
    // The build entry is live, so the list draws it, but in no session's group: a grouping that
    // took it in would hold a group the rail and the sessions list could count.
    const buildOnly = new AttentionSummary([providerBuildItem()]);
    expect(buildOnly.liveItems).toHaveLength(1);
    expect(buildOnly.groups).toStrictEqual([]);
    expect(
      attentionCountOf({
        phase: "read",
        summary: new AttentionSummary([attentionItem({ id: "1" }), providerBuildItem()]),
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: ADDRESSED_SESSION_IDS,
      }),
    ).toBe(1);
  });
});
