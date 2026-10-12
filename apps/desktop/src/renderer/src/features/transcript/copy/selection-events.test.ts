// A copy over rows the store let go reads every event between the selection's ends in log order:
// the ones the store holds, and each stretch it let go between them read back, a page at a time,
// so a long run's cut calls are copied though the store no longer holds them.

import { describe, expect, it } from "vitest";

import {
  PAGED_SESSION_ID,
  pagedSessionEventAt,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "../logs.test-support.js";
import {
  readSelectedEvents,
  type HeldTranscript,
  type SelectionEventSpan,
} from "./selection-events.js";

/** Positions `first` through `last`, in order. */
function positions(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index);
}

/** A thousand events, the store holding the first hundred and the last hundred. */
const LOG_LENGTH = 1_000;
const HELD: HeldTranscript = {
  events: [...positions(0, 99), ...positions(900, LOG_LENGTH - 1)].map(pagedSessionEventAt),
  headCursor: undefined,
  // Eight hundred events, more than three pages of the largest read.
  releasedStretches: [
    { lastHeldSequenceBefore: 99, firstHeldCursorAfter: transcriptFixtureStreamCursor(900) },
  ],
};

/** The span from position `start` to position `end`. */
function spanBetween(start: number, end: number): SelectionEventSpan {
  return {
    start: { sequence: start },
    end: { sequence: end, cursor: transcriptFixtureStreamCursor(end) },
  };
}

describe("the events a copy over let-go rows reads", () => {
  it("reads each stretch the store let go back into its place, ends inside it or past it", async () => {
    const log = scriptedTranscriptLog(LOG_LENGTH);
    const read = { readPage: log.read, sessionId: PAGED_SESSION_ID, isCurrent: () => true };

    const across = await readSelectedEvents(spanBetween(50, 950), HELD, read);
    expect(across?.map((event) => event.sequence)).toStrictEqual(positions(50, 950));

    const endingInside = await readSelectedEvents(spanBetween(50, 400), HELD, read);
    expect(endingInside?.map((event) => event.sequence)).toStrictEqual(positions(50, 400));
  });
});
