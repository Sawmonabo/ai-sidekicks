// A backward page grows a log strictly before its head: a row at or above the head sequence is
// already this window's, and merging it would put one row in the log twice.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { describe, expect, it } from "vitest";

import { mergeEarlierWindow } from "./transcript-window.js";
import { eventOfKind } from "#test/helpers/session/events.js";

const SESSION_ID = "session-transcript-window";

/** The kind every row here carries: a kind the wire sends; the merge reads only sequences. */
const RUNNING_KIND: SessionEventType = "agent.run.running";

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, RUNNING_KIND, sequence));
}

describe("mergeEarlierWindow — a page grows a log at the head and nowhere else", () => {
  it("refuses a row at or above the head sequence rather than merging it", () => {
    // Without the guard, row 10 lands twice.
    const merge = mergeEarlierWindow(eventsAt([10, 11]), eventsAt([9, 10, 11]));

    expect(merge.transcript.map((event) => event.sequence)).toStrictEqual([9, 10, 11]);
    expect(merge.admitted).toBe(1);
    expect(merge.refusedNotEarlier).toBe(2);
  });
});
