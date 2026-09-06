// What raises a banner, and what deliberately does not.
//
// The class is driven directly rather than through a rendered surface, because every
// property here is about HISTORY — a baseline, a remembered id, an eviction — and a
// component test would establish each of those by re-rendering, which is a slower way
// of asking a smaller question. The surface's own file drives the emission end to end.

import { describe, expect, it } from "vitest";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "../../core/index.js";
import type { AttentionItem } from "../../bridge/index.js";
import { AttentionNotifier } from "./attention-notifier.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

const AWAY = { activeSessionId: "session-b", isWindowFocused: false } as const;
const WATCHING_A = { activeSessionId: "session-a", isWindowFocused: true } as const;

describe("the attention notifier", () => {
  it("announces nothing from the first settled read", () => {
    // Mounting the destination is not an event. Without this, navigating to Sessions
    // would fire one banner per outstanding approval every single time.
    const notifier = new AttentionNotifier();

    expect(notifier.arrivalsToAnnounce([item(), item({ id: "attention-2" })], AWAY)).toStrictEqual(
      [],
    );
  });

  it("announces an item that arrives after the baseline, once", () => {
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce([item()], AWAY);
    const arrival = item({ id: "attention-2" });

    const first = notifier.arrivalsToAnnounce([item(), arrival], AWAY);
    // The same projection read back — every re-read answers the same list, so a
    // notifier that keyed on the read rather than on the item would announce this
    // item again on every refresh for as long as it stayed unresolved.
    const second = notifier.arrivalsToAnnounce([item(), arrival], AWAY);

    expect(first.map((announced) => announced.id)).toStrictEqual(["attention-2"]);
    expect(second).toStrictEqual([]);
  });

  it("stays silent about the session a focused window is looking at", () => {
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce([], WATCHING_A);

    const arrivals = notifier.arrivalsToAnnounce(
      [
        item({ id: "on-screen", sessionId: "session-a" }),
        item({ id: "elsewhere", sessionId: "session-b" }),
      ],
      WATCHING_A,
    );

    expect(arrivals.map((announced) => announced.id)).toStrictEqual(["elsewhere"]);
  });

  it("announces every session's item while the window is not focused", () => {
    // The negative control for the rule above: the suppression is about what a person
    // can already see, so a window nobody is looking at suppresses nothing.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce([], { activeSessionId: "session-a", isWindowFocused: false });

    const arrivals = notifier.arrivalsToAnnounce(
      [item({ id: "on-screen", sessionId: "session-a" })],
      { activeSessionId: "session-a", isWindowFocused: false },
    );

    expect(arrivals.map((announced) => announced.id)).toStrictEqual(["on-screen"]);
  });

  it("does not re-announce an item it withheld once the person looks away", () => {
    // A held-back item is still an item this window has SEEN. Announcing it when the
    // route moved would be a banner about something that did not just happen.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce([], WATCHING_A);
    const onScreen = item({ id: "on-screen", sessionId: "session-a" });
    notifier.arrivalsToAnnounce([onScreen], WATCHING_A);

    expect(notifier.arrivalsToAnnounce([onScreen], AWAY)).toStrictEqual([]);
  });

  it("forgets the oldest id rather than growing without bound", () => {
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce([item({ id: "oldest" })], AWAY);
    const fill = Array.from({ length: ATTENTION_NOTIFIED_ITEM_CAP }, (_unused, index) =>
      item({ id: `filler-${String(index)}` }),
    );
    notifier.arrivalsToAnnounce(fill, AWAY);

    // The eviction is observable exactly here: the oldest id has been dropped, so the
    // item is treated as an arrival again. A duplicate banner is the direction this
    // cap is allowed to be wrong in; an unbounded set is not.
    expect(
      notifier
        .arrivalsToAnnounce([item({ id: "oldest" }), fill[fill.length - 1]!], AWAY)
        .map((announced) => announced.id),
    ).toStrictEqual(["oldest"]);
  });
});
