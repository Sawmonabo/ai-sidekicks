// The half of the attention panel that is for people who cannot see it.
//
// `attention-sentences.test.ts` next door pins WHAT is said. This file pins WHEN,
// which is the part a sentence composer cannot get wrong on its own and a surface
// can: silent while the read is in flight, said once when it settles, said again
// when a later settlement differs, and never repeated because the surface happened
// to render.
//
// The last one is the case with teeth. This read RE-READS — every session store
// that moves pushes it — so a hook that spoke on each render would say the same
// sentence at every push, and a hook that latched a flag at mount would say the
// first settlement and swallow the coverage gap that appeared on the third.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { ManualClock } from "@renderer/lib/clock.js";
import { refuse } from "@renderer/lib/refusal.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import {
  AttentionPlane,
  type AttentionReading,
} from "@renderer/store/attention/attention-summary.js";
import { useAttentionSettlementAnnouncement } from "@renderer/console/sessions/notifications/attention-read.js";

const CREATED_AT = "2026-01-01T10:00:00.000Z";

/** One live item, built the way the projection would hand it over. */
function itemNeeding(id: string): AttentionItem {
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

/** A settled read that answered, with whatever coverage a case names. */
function answered(options: {
  readonly items?: readonly AttentionItem[];
  readonly refusedSessionIds?: readonly string[];
}): AttentionReading {
  return {
    phase: "read",
    plane: new AttentionPlane(options.items ?? []),
    droppedCount: 0,
    refusedSessions: (options.refusedSessionIds ?? []).map((sessionId) => ({
      sessionId,
      refusal: refuse(
        "attention-plane",
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
 * Mount the probe under the console's real announcer, with its calls recorded.
 *
 * The announcer is REAL and its `announce` is spied rather than replaced, so the
 * hook is exercised against the object the frame actually mounts — the spy answers
 * "what was said and how many times", which reading the live region cannot: a
 * sentence said twice in a row leaves the region holding exactly the text it held
 * after the first.
 *
 * A `ManualClock` freezes the hold window, so nothing published here clears on how
 * fast the runner happened to be.
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
  it("says nothing while the read is still in flight", () => {
    // `undefined` is the hook's "still reading" arm and is deliberately not an
    // empty string: an empty string is what the announcer publishes to CLEAR a
    // region, so a silent arm written that way would wipe whatever was standing.
    const probe = mountProbe({ phase: "reading" });

    expect(probe.spoken()).toStrictEqual([]);
  });

  it("says what a served read found, once", async () => {
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a"), itemNeeding("b")] }));

    expect(probe.spoken()).toStrictEqual(["2 items need you."]);
  });

  it("does not say it again because the surface rendered again", async () => {
    // The negative control for a hook that announced from its render body or from
    // an effect keyed on the reading OBJECT: this read is pushed at from every
    // session store, so an equal reading arrives repeatedly with a new identity.
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    await probe.rerender(answered({ items: [itemNeeding("a")] }));

    expect(probe.spoken()).toStrictEqual(["One item needs you."]);
  });

  it("speaks a later settlement that says something different", async () => {
    // The negative control from the other side: a flag latched at the first
    // settlement would leave every re-read after it silent, so the coverage gap
    // below would reach only the people who can see the panel.
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(answered({ items: [itemNeeding("a")] }));
    await probe.rerender(answered({ items: [itemNeeding("a")], refusedSessionIds: ["session-b"] }));

    expect(probe.spoken()).toStrictEqual([
      "One item needs you.",
      "One item needs you. One session could not be checked.",
    ]);
  });

  it("names both facts when the read did not cover every session", async () => {
    const probe = mountProbe({ phase: "reading" });
    await probe.rerender(
      answered({ items: [itemNeeding("a")], refusedSessionIds: ["session-b", "session-c"] }),
    );

    const [spoken] = probe.spoken();
    expect(spoken).toContain("One item needs you.");
    expect(spoken).toContain("2 sessions could not be checked.");
  });
});
