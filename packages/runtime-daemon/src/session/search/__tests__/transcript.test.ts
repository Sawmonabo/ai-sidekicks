// `transcript.search` over one session's rows in the full-text index, paged newest first, with
// the first page checked against its contract.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import { TranscriptSearchResponseSchema } from "@ai-sidekicks/contracts/transcript/search";

import { SessionNotFoundError } from "../../../ipc/session-errors.js";
import { openDatabase } from "../../migration-runner.js";
import { insertEvent, insertSession, sessionIdOf } from "../__fixtures__/index-rows.js";
import { TranscriptSearchService } from "../transcript.js";

describe("transcript.search", () => {
  let database: Database;
  let transcriptSearch: TranscriptSearchService;
  const sessionId = sessionIdOf(1);

  beforeEach(() => {
    database = openDatabase(":memory:");
    transcriptSearch = new TranscriptSearchService(database);
    insertSession(database, sessionId, { name: "retry work" });
  });

  afterEach(() => {
    database.close();
  });

  it("pages the session's own rows newest first and counts every match in the session", () => {
    const otherSessionId = sessionIdOf(2);
    insertSession(database, otherSessionId);
    insertEvent(database, {
      sessionId: otherSessionId,
      sequence: 0,
      type: "user.message",
      message: "retry",
    });
    const rowIds = [1, 2, 3].map((sequence) =>
      insertEvent(database, {
        sessionId,
        sequence,
        type: "assistant.message",
        content: `attempt ${String(sequence)}: retry, then retry`,
      }),
    );

    const firstPage = TranscriptSearchResponseSchema.parse(
      transcriptSearch.search({ sessionId, query: "retry", limit: 2 }),
    );
    // The title is no row of the log; the other session's row is not this session's.
    expect(firstPage).toEqual({
      matchCount: 6,
      hits: [
        {
          rowId: rowIds[2],
          cursor: encodeEventCursor(3),
          snippet: "attempt 3: retry, then retry",
          matchRanges: [
            { start: 11, end: 16 },
            { start: 23, end: 28 },
          ],
        },
        expect.objectContaining({ rowId: rowIds[1], cursor: encodeEventCursor(2) }),
      ],
      hasMore: true,
      nextCursor: encodeEventCursor(2),
    });

    const secondPage = transcriptSearch.search({
      sessionId,
      query: "retry",
      limit: 2,
      beforeCursor: encodeEventCursor(2),
    });
    expect(secondPage).toEqual({
      matchCount: 6,
      hits: [expect.objectContaining({ rowId: rowIds[0], cursor: encodeEventCursor(1) })],
      hasMore: false,
    });
  });

  it("counts and marks a row carrying the characters a match is marked with as plain text", () => {
    insertEvent(database, {
      sessionId,
      sequence: 1,
      type: "assistant.message",
      content: "\uFDD1retry \uFDD0then retry\uFDD0",
    });

    expect(transcriptSearch.search({ sessionId, query: "retry" })).toEqual({
      matchCount: 2,
      hits: [
        {
          rowId: expect.any(String),
          cursor: encodeEventCursor(1),
          snippet: " retry  then retry ",
          matchRanges: [
            { start: 1, end: 6 },
            { start: 13, end: 18 },
          ],
        },
      ],
      hasMore: false,
    });
  });

  it("refuses a session the daemon does not hold with session.not_found", () => {
    expect(() => transcriptSearch.search({ sessionId: sessionIdOf(9), query: "retry" })).toThrow(
      SessionNotFoundError,
    );
  });
});
