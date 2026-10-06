// What raises a banner and what deliberately does not. The class is driven directly, because
// every property here is about history: a baseline, a remembered id, an eviction.

import { describe, expect, it } from "vitest";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "./notifier.js";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { AttentionSummary, type AnsweredAttentionReading } from "./summary.js";
import { AttentionNotifier } from "./notifier.js";

/** The two sessions the items here belong to. */
const SESSION_A = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a01");
const SESSION_B = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a02");

/**
 * One item, whose canonical event follows its id unless a case says otherwise.
 *
 * Derived rather than constant, because the notifier is keyed on the event: a fixed
 * `sourceEventId` would make every item the same news. A case wanting two items over one event
 * passes the event explicitly.
 */
function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  const id = overrides.id ?? "attention-1";
  return {
    id,
    momentId: "moment-1",
    sessionId: SESSION_A,
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
    sourceEventId: `event-for-${id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    bannerState: "pending",
    seen: false,
    ...overrides,
  };
}

/**
 * The sessions every case here names, so an ordinary read covers both of them. The address set
 * itself moves in `notifier.address-set.test.ts`.
 */
const ADDRESSED_SESSION_IDS: readonly string[] = [SESSION_A, SESSION_B];

/** One settled read carrying these items, over the sessions this file addresses. */
function settledRead(
  items: readonly AttentionItem[],
  addressedSessionIds: readonly string[] = ADDRESSED_SESSION_IDS,
): AnsweredAttentionReading {
  return {
    phase: "read",
    summary: new AttentionSummary(items),
    droppedCount: 0,
    refusedSessions: [],
    addressedSessionIds,
  };
}

describe("the attention notifier", () => {
  it("announces nothing from the first settled read", () => {
    // Mounting the destination is not an event; otherwise navigating to Sessions would fire a
    // banner per outstanding approval every time.
    const notifier = new AttentionNotifier();

    expect(
      notifier.arrivalsToAnnounce(settledRead([item(), item({ id: "attention-2" })])),
    ).toStrictEqual([]);
  });

  it("announces an item that arrives after the baseline, once", () => {
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([item()]));
    const arrival = item({ id: "attention-2" });

    const first = notifier.arrivalsToAnnounce(settledRead([item(), arrival]));
    // The same projection read back: a notifier keyed on the read rather than the item would
    // announce this item on every refresh while it stayed unresolved.
    const second = notifier.arrivalsToAnnounce(settledRead([item(), arrival]));

    expect(first.map((announced) => announced.id)).toStrictEqual(["attention-2"]);
    expect(second).toStrictEqual([]);
  });

  it("raises nothing for a standing projection larger than the cap", () => {
    // Every item is unresolved, so every read returns all of them. An eviction over the
    // remembered set alone would drop the live id it just added, announce it on the next read,
    // and walk along the whole projection: a banner per item on every refresh.
    const notifier = new AttentionNotifier();
    const standing = Array.from({ length: ATTENTION_NOTIFIED_ITEM_CAP + 1 }, (_unused, index) =>
      item({ id: `standing-${String(index)}` }),
    );
    notifier.arrivalsToAnnounce(settledRead(standing));

    expect(notifier.arrivalsToAnnounce(settledRead(standing))).toStrictEqual([]);
    // The third read is where a cap that had evicted one live id would announce its first item.
    expect(notifier.arrivalsToAnnounce(settledRead(standing))).toStrictEqual([]);
  });

  it("raises one banner for a run and the session aggregate that represents it", () => {
    // Two item ids over one canonical event, as a projection carrying both scopes looks: the
    // aggregate takes the representative's `sourceEventId`. Keyed on the item id, one run
    // beginning to wait announced twice.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([]));
    const runScoped = item({ id: "run-1:pending_approval", sourceEventId: "event-1" });
    const aggregate = item({ id: "session-a:session", sourceEventId: "event-1" });

    const arrivals = notifier.arrivalsToAnnounce(settledRead([runScoped, aggregate]));

    expect(arrivals.map((announced) => announced.id)).toStrictEqual(["run-1:pending_approval"]);
  });
});
