// What raises a banner, and what deliberately does not.
//
// The class is driven directly, because every property here is about HISTORY — a
// baseline, a remembered id, an eviction.

import { describe, expect, it } from "vitest";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "@renderer/console/core/constants/sessions-caps.js";
import type { AttentionItem } from "@renderer/console/bridge/wire-shapes/attention-projection.js";
import { AttentionPlane, type AnsweredAttentionReading } from "./attention-summary.js";
import { AttentionNotifier } from "./attention-notifier.js";

/**
 * One item, whose canonical event follows its id unless a case says otherwise.
 *
 * DERIVED RATHER THAN CONSTANT, because the emitter is keyed on the event now: a
 * fixed `sourceEventId` would make every item in a case the same piece of news, and
 * every claim below about a SECOND item arriving would be asserting the dedup rule by
 * accident instead of the rule it names. A case that wants two items over one event —
 * a run and its session aggregate — says so by passing the event explicitly.
 */
function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  const id = overrides.id ?? "attention-1";
  return {
    id,
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: `event-for-${id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * The sessions every case here names, so an ordinary read covers both of them.
 *
 * The address set is what makes a session's items announceable at all, and these
 * cases are about the OTHER rules — the dedup, the cap — so they read
 * over a window that has been watching both sessions all along. The ordering matrix
 * next door is where the set itself moves.
 */
const ADDRESSED_SESSION_IDS: readonly string[] = ["session-a", "session-b"];

/** One settled read carrying these items, over the sessions this file addresses. */
function settledRead(
  items: readonly AttentionItem[],
  addressedSessionIds: readonly string[] = ADDRESSED_SESSION_IDS,
): AnsweredAttentionReading {
  return {
    phase: "read",
    plane: new AttentionPlane(items),
    droppedCount: 0,
    refusedSessions: [],
    addressedSessionIds,
  };
}

describe("the attention notifier", () => {
  it("announces nothing from the first settled read", () => {
    // Mounting the destination is not an event. Without this, navigating to Sessions
    // would fire one banner per outstanding approval every single time.
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
    // The same projection read back — every re-read answers the same list, so a
    // notifier that keyed on the read rather than on the item would announce this
    // item again on every refresh for as long as it stayed unresolved.
    const second = notifier.arrivalsToAnnounce(settledRead([item(), arrival]));

    expect(first.map((announced) => announced.id)).toStrictEqual(["attention-2"]);
    expect(second).toStrictEqual([]);
  });

  it("raises nothing for a standing projection larger than the cap", () => {
    // The storm this cap used to cause. Every one of these items is unresolved, so
    // every read returns all of them — and an eviction that ran over the remembered
    // set alone dropped the live id it had just added, found it missing on the next
    // read, announced it, and walked the drop along the whole projection. What a
    // person got was one banner per outstanding item, on every refresh, forever.
    const notifier = new AttentionNotifier();
    const standing = Array.from({ length: ATTENTION_NOTIFIED_ITEM_CAP + 1 }, (_unused, index) =>
      item({ id: `standing-${String(index)}` }),
    );
    notifier.arrivalsToAnnounce(settledRead(standing));

    expect(notifier.arrivalsToAnnounce(settledRead(standing))).toStrictEqual([]);
    // And it does not decay into the storm one read later either: the third read is
    // where a cap that had evicted exactly one live id would announce its first item.
    expect(notifier.arrivalsToAnnounce(settledRead(standing))).toStrictEqual([]);
  });

  it("keeps a cleared id while there is room under the cap", () => {
    // The negative control for pruning every id a read did not return. A fan-out that
    // refused for one session answers without that session's items, and forgetting
    // them on sight would re-announce the lot the moment the read recovered.
    const notifier = new AttentionNotifier();
    const carried = item({ id: "carried", sessionId: "session-b" });
    notifier.arrivalsToAnnounce(settledRead([item(), carried]));
    notifier.arrivalsToAnnounce(settledRead([item()]));

    expect(notifier.arrivalsToAnnounce(settledRead([item(), carried]))).toStrictEqual([]);
  });

  it("forgets the oldest cleared id rather than growing without bound", () => {
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([item({ id: "oldest" })]));
    const fill = Array.from({ length: ATTENTION_NOTIFIED_ITEM_CAP }, (_unused, index) =>
      item({ id: `filler-${String(index)}` }),
    );
    notifier.arrivalsToAnnounce(settledRead(fill));

    // The eviction is observable exactly here: `oldest` cleared from the projection
    // and the fill then took the whole cap, so the oldest CLEARED id was dropped and
    // the item is treated as an arrival again. A duplicate banner is the direction
    // this cap is allowed to be wrong in; an unbounded set is not.
    expect(
      notifier
        .arrivalsToAnnounce(settledRead([item({ id: "oldest" }), fill[fill.length - 1]!]))
        .map((announced) => announced.id),
    ).toStrictEqual(["oldest"]);
  });

  it("raises one banner for a run and the session aggregate that represents it", () => {
    // Two item ids over one canonical event, which is what a projection carrying both
    // scopes actually looks like: `deriveAttentionProjection` builds the aggregate
    // from its contributors and takes the representative's `sourceEventId`. Keyed on
    // the item id, this fold announced one run beginning to wait twice — two banners,
    // half a second apart, for one thing that happened.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([]));
    const runScoped = item({ id: "run-1:pending_approval", sourceEventId: "event-1" });
    const aggregate = item({ id: "session-a:session", sourceEventId: "event-1" });

    const arrivals = notifier.arrivalsToAnnounce(settledRead([runScoped, aggregate]));

    expect(arrivals.map((announced) => announced.id)).toStrictEqual(["run-1:pending_approval"]);
  });

  it("negative control: two items over two events are two banners", () => {
    // Without this, the case above would pass over a fold that had collapsed every
    // settlement to a single banner — one approval announced and the second one that
    // arrived beside it silently dropped, which is the failure the dedup is one step
    // away from.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([]));

    const arrivals = notifier.arrivalsToAnnounce(
      settledRead([item({ id: "run-1:pending_approval" }), item({ id: "run-2:pending_approval" })]),
    );

    expect(arrivals.map((announced) => announced.id)).toStrictEqual([
      "run-1:pending_approval",
      "run-2:pending_approval",
    ]);
  });

  it("does not re-announce the aggregate on a later read that carries its event", () => {
    // The cross-settlement half. The aggregate's own id may move, because the
    // representative is allowed to change — so a memory keyed on the item id would call a
    // re-keyed aggregate new and raise a second banner for news it had already told.
    const notifier = new AttentionNotifier();
    notifier.arrivalsToAnnounce(settledRead([]));
    const runScoped = item({ id: "run-1:pending_approval", sourceEventId: "event-1" });
    notifier.arrivalsToAnnounce(settledRead([runScoped]));

    const arrivals = notifier.arrivalsToAnnounce(
      settledRead([
        runScoped,
        item({ id: "session-a:pending_approval", sourceEventId: "event-1" }),
      ]),
    );

    expect(arrivals).toStrictEqual([]);
  });
});
