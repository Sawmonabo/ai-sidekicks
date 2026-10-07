// The drawn-row filter across passes over one session: a pass over new rows decides again, and a
// streamed update keeps the decision while handing on the current row objects.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { describe, expect, it } from "vitest";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../logs.test-support.js";
import { TranscriptRowRetention } from "../window/row-retention.js";
import { deriveTranscriptWindow } from "../window/transcript-window.js";
import { DrawnRowFilter } from "./drawn-rows.js";

const SESSION_ID = "session-drawn-rows";
/** A session event the stand-in renderer below has no body for. */
const UNDRAWN_KIND = "session.renamed";

/** One session-scoped event at a log position, so no run group or fold is involved. */
function eventAt(index: number, kind: string): ProjectedSessionEvent {
  return {
    id: transcriptFixtureEventId(index),
    sessionId: SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind,
    occurredAt: transcriptFixtureStampAt(index),
    payload: {},
  };
}

/** A log whose odd positions are events the renderer draws nothing for. */
function alternatingLog(count: number): ProjectedSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) =>
    eventAt(index, index % 2 === 1 ? UNDRAWN_KIND : "user.message"),
  );
}

function drawsMessages(row: TranscriptEventRow): boolean {
  return row.type !== UNDRAWN_KIND;
}

describe("the drawn-row filter over one session's passes", () => {
  it("decides again when rows arrive, and keeps its decision through a streamed update", () => {
    const retention = new TranscriptRowRetention();
    const filter = new DrawnRowFilter();
    const firstLog = alternatingLog(3);
    const first = filter.filter(deriveTranscriptWindow(firstLog, retention), drawsMessages);
    expect(first.viewportRows.map((row) => row.key)).toStrictEqual([
      transcriptFixtureEventId(0),
      transcriptFixtureEventId(2),
    ]);

    // The newest message streamed more text: its object is new, its place is not.
    const newest = firstLog[2];
    if (newest === undefined) {
      throw new Error("the log has no third event");
    }
    const streamedModel = deriveTranscriptWindow(
      [...firstLog.slice(0, 2), { ...newest, payload: { text: "more of the message" } }],
      retention,
    );
    const streamed = filter.filter(streamedModel, drawsMessages);
    expect(streamed.rows.at(-1)).toBe(streamedModel.rows.at(-1));
    expect(streamed.rows.at(-1)).not.toBe(first.rows.at(-1));
    expect(streamed.viewportRows).toStrictEqual(first.viewportRows);

    // Two rows arrive, one of them undrawn: the positions the last decision held no longer fit.
    const grown = filter.filter(
      deriveTranscriptWindow(alternatingLog(5), retention),
      drawsMessages,
    );
    expect(grown.viewportRows.map((row) => row.key)).toStrictEqual([
      transcriptFixtureEventId(0),
      transcriptFixtureEventId(2),
      transcriptFixtureEventId(4),
    ]);
    expect(grown.rows.map((row) => row.id)).toStrictEqual([
      transcriptFixtureEventId(0),
      transcriptFixtureEventId(2),
      transcriptFixtureEventId(4),
    ]);
  });
});
