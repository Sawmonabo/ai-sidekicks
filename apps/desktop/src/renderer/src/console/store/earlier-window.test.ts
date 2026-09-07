// The backward fold's three rules, asserted directly.
//
// A pure function over two arrays, so every case here is the rule itself rather than a
// store driven into a state. The negative controls are the interesting half: each rule
// is asserted by a page that BREAKS it and is counted rather than merged.

import { describe, expect, it } from "vitest";

import { mergeEarlierWindow } from "./earlier-window.js";
import { eventOfKind } from "./session-event.test-support.js";

const SESSION_ID = "session-earlier-window";

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence));
}

describe("mergeEarlierWindow — a page grows a log at the head and nowhere else", () => {
  it("puts an earlier page in front, oldest first, in the page's own order", () => {
    const merge = mergeEarlierWindow(eventsAt([10, 11]), eventsAt([7, 8, 9]));

    expect(merge.timeline.map((event) => event.sequence)).toStrictEqual([7, 8, 9, 10, 11]);
    expect(merge.admitted).toBe(3);
    expect(merge.refusedNotEarlier).toBe(0);
    expect(merge.duplicates).toBe(0);
  });

  it("refuses a row at or above the head sequence rather than merging it", () => {
    // The negative control for "strictly earlier, or not at all": without the guard
    // the row at 10 lands a second time and one log entry has two positions.
    const merge = mergeEarlierWindow(eventsAt([10, 11]), eventsAt([9, 10, 11]));

    expect(merge.timeline.map((event) => event.sequence)).toStrictEqual([9, 10, 11]);
    expect(merge.admitted).toBe(1);
    expect(merge.refusedNotEarlier).toBe(2);
  });

  it("keeps the first row of a repeated sequence and counts the rest", () => {
    const repeated = [
      eventOfKind(SESSION_ID, "run.started", 7),
      eventOfKind(SESSION_ID, "run.completed", 7),
    ];
    const merge = mergeEarlierWindow(eventsAt([10]), repeated);

    expect(merge.admitted).toBe(1);
    expect(merge.duplicates).toBe(1);
    expect(merge.timeline[0]?.kind).toBe("run.started");
  });

  it("admits every row of a page into an empty log", () => {
    // No head sequence is not "everything is too late" — it is a window holding
    // nothing, where every row of the page is earlier than all of it.
    const merge = mergeEarlierWindow([], eventsAt([1, 2]));

    expect(merge.admitted).toBe(2);
    expect(merge.refusedNotEarlier).toBe(0);
  });

  it("returns the log's own array when a page admits nothing", () => {
    // Identity, not equality: a consumer keyed on the log's reference must not
    // re-project for a page that added no row.
    const timeline = eventsAt([10, 11]);
    const merge = mergeEarlierWindow(timeline, eventsAt([10]));

    expect(merge.timeline).toBe(timeline);
  });
});
