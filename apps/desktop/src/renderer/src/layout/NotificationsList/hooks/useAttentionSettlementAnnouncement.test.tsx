// The half of the attention panel for people who cannot see it. `attention-sentences.test.ts`
// pins what is said; this pins when: the first settlement answers the panel's first read and
// stands, and a later settlement that says something different is spoken. The read re-reads
// whenever a session store moves, so a hook latching a flag at its first settlement would swallow
// a later coverage gap.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { AttentionSummary, type AttentionReading } from "#renderer/store/attention/summary.js";
import { useAttentionSettlementAnnouncement } from "./useAttentionSettlementAnnouncement.js";

/** The session the items here belong to. */
const SESSION_A = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a01");

const CREATED_AT = "2026-01-01T10:00:00.000Z";

/** One live item, built the way the projection would hand it over. */
function itemNeeding(id: string): AttentionItem {
  return {
    id,
    momentId: "moment-1",
    sessionId: SESSION_A,
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

/** A settled read that answered, with whatever coverage a case names. */
function answered(options: {
  readonly items?: readonly AttentionItem[];
  readonly refusedSessionIds?: readonly string[];
}): AttentionReading {
  return {
    phase: "read",
    summary: new AttentionSummary(options.items ?? []),
    droppedCount: 0,
    refusedSessions: (options.refusedSessionIds ?? []).map((sessionId) => ({
      sessionId,
      refusal: refuse(
        "attention-projection",
        "session.not_found",
        "That session is not known to the daemon.",
      ),
    })),
    addressedSessionIds: options.refusedSessionIds ?? [],
  };
}

/** The one component under test: the hook, and nothing that could speak beside it. */
function AnnouncementProbe(props: { readonly reading: AttentionReading }): null {
  useAttentionSettlementAnnouncement(props.reading);
  return null;
}

/**
 * Mounts the probe under the real announcer with `announce` spied, not replaced, on a frozen clock.
 */
function mountProbe(reading: AttentionReading): {
  readonly spoken: () => readonly string[];
  readonly rerender: (next: AttentionReading) => Promise<void>;
} {
  const { announcer, spoken } = spiedAnnouncer();
  const mounted = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <AnnouncementProbe reading={reading} />
    </LiveAnnouncerProvider>,
  );
  return {
    spoken,
    rerender: async (next) => {
      await act(async () => {
        mounted.rerender(
          <LiveAnnouncerProvider announcer={announcer}>
            <AnnouncementProbe reading={next} />
          </LiveAnnouncerProvider>,
        );
        await crossMacrotaskBoundary();
      });
    },
  };
}

describe("the attention reading announces its settlement", () => {
  it("leaves the first settlement unsaid and speaks a later one that says something different", async () => {
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    expect(probe.spoken()).toStrictEqual([]);
    // A re-read that found the same thing is silent.
    await probe.rerender({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    await probe.rerender(answered({ items: [itemNeeding("a")], refusedSessionIds: ["session-b"] }));

    expect(probe.spoken()).toStrictEqual(["One item needs you. One session could not be checked."]);
  });
});
