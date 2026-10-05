// Driven through `deriveTranscriptWindow`, not the table alone: retention matters as a property
// of the derivation (which row objects reach the feed and stay recognizable). Logs are built here
// because two cases need logs differing in one member of one event, which no shared builder
// offers; ids and instants still come from `transcript-logs.test-support.ts`.

import { describe, expect, it } from "vitest";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import {
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../transcript-logs.test-support.js";
import { TranscriptRowRetention } from "./row-retention.js";
import { deriveTranscriptWindow } from "./transcript-window.js";

const SESSION_ID = "session-transcript-row-retention";

function logEntry(
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
): ProjectedSessionEvent {
  return {
    id: transcriptFixtureEventId(sequence),
    sessionId: SESSION_ID,
    sequence,
    cursor: transcriptFixtureStreamCursor(sequence),
    kind: "user.message",
    occurredAt: transcriptFixtureStampAt(sequence),
    payload,
  };
}

function log(count: number): ProjectedSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => logEntry(index, { index }));
}

const LOG_ENTRY_COUNT = 4;

describe("the transcript window's row retention", () => {
  it("publishes the same row objects when the log gained an entry and nothing else moved", () => {
    const retention = new TranscriptRowRetention();
    // One array appended to, as the store does (a new array over the same entry objects);
    // rebuilt entries would carry fresh payloads and rightly take new row identities.
    const entries = log(LOG_ENTRY_COUNT);
    const before = deriveTranscriptWindow(entries, retention);
    const after = deriveTranscriptWindow([...entries, logEntry(LOG_ENTRY_COUNT, {})], retention);

    // Both the row and its identity triple keep identity: the feed's row memo compares the row
    // and the viewport's compares the triple.
    for (const row of before.rows) {
      expect(after.rowsByKey.get(row.id)).toBe(row);
    }
    for (const identity of before.viewportRows) {
      expect(after.viewportRows.find((candidate) => candidate.key === identity.key)).toBe(identity);
    }
    expect(after.rows).toHaveLength(LOG_ENTRY_COUNT + 1);
  });

  it("publishes a new object for a row whose members moved", () => {
    // Guards the case above against a table that returns whatever it holds under a key without
    // comparing, which would show a stale row.
    const retention = new TranscriptRowRetention();
    const first = [logEntry(0, { index: 0 }), logEntry(1, { index: 1 })];
    const before = deriveTranscriptWindow(first, retention);
    const movedEntry = { ...logEntry(1, { index: 1 }), occurredAt: "2026-06-01T00:00:00.000Z" };
    const after = deriveTranscriptWindow(
      [first[0] as ProjectedSessionEvent, movedEntry],
      retention,
    );

    const unchangedRow = before.rows[0];
    const movedRow = before.rows[1];
    if (unchangedRow === undefined || movedRow === undefined) {
      throw new Error("the fixture log projected fewer rows than it has entries");
    }
    expect(after.rowsByKey.get(unchangedRow.id)).toBe(unchangedRow);
    expect(after.rowsByKey.get(movedRow.id)).not.toBe(movedRow);
    expect(after.rowsByKey.get(movedRow.id)?.timestamp).toBe("2026-06-01T00:00:00.000Z");
  });

  it("forgets a row the projection stopped publishing", () => {
    // The table holds one pass, so a row that left and came back takes a new object; an
    // accumulating map would hand back the one it kept.
    const retention = new TranscriptRowRetention();
    const entries = log(LOG_ENTRY_COUNT);
    const held = deriveTranscriptWindow(entries, retention).rows[0];
    if (held === undefined) {
      throw new Error("the fixture log projected no rows");
    }
    deriveTranscriptWindow([], retention);
    const readmitted = deriveTranscriptWindow(entries, retention);

    expect(readmitted.rowsByKey.get(held.id)).not.toBe(held);
  });
});
