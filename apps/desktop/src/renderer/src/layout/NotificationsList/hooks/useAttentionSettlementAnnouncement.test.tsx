// The half of the attention panel for people who cannot see it. `attention-sentences.test.ts`
// pins what is said; this pins that a later settlement that says something different is spoken
// too. The read re-reads whenever a session store moves, so a hook latching a flag at its first
// settlement would swallow a later coverage gap.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { ManualClock } from "#renderer/lib/clock.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { LiveAnnouncer } from "#renderer/components/LiveAnnouncer/announcer.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { AttentionSummary, type AttentionReading } from "#renderer/store/attention/summary.js";
import { useAttentionSettlementAnnouncement } from "./useAttentionSettlementAnnouncement.js";

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
 * Mounts the probe under the real announcer with `announce` spied, not replaced. The spy records
 * what was said and how often, which the live region cannot: a sentence said twice leaves the same
 * text. A `ManualClock` freezes the hold window.
 */
function mountProbe(reading: AttentionReading): {
  readonly spoken: () => readonly string[];
  readonly rerender: (next: AttentionReading) => Promise<void>;
} {
  const announcer = new LiveAnnouncer({ clock: new ManualClock() });
  const announce = vi.spyOn(announcer, "announce");
  const mounted = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <AnnouncementProbe reading={reading} />
    </LiveAnnouncerProvider>,
  );
  return {
    spoken: () => announce.mock.calls.map(([message]) => message),
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
  it("speaks a later settlement that says something different", async () => {
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    await probe.rerender(answered({ items: [itemNeeding("a")], refusedSessionIds: ["session-b"] }));

    expect(probe.spoken()).toStrictEqual([
      "One item needs you.",
      "One item needs you. One session could not be checked.",
    ]);
  });
});
