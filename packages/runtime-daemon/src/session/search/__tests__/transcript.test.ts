// `transcript.search` over one session's rows in the search index: paged newest first, one hit per
// row, every page counting every match in the session, which is the sum of the marks its hits
// carry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import {
  TranscriptSearchResponseSchema,
  type TranscriptSearchHit,
} from "@ai-sidekicks/contracts/transcript/search";

import { insertEvent, insertSession, sessionIdOf } from "../__fixtures__/index-rows.js";
import { SearchFixture } from "../__fixtures__/search-services.js";

describe("transcript.search", () => {
  let fixture: SearchFixture;

  beforeEach(async () => {
    fixture = await SearchFixture.open();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("pages the session's own rows newest first and counts every match it marks", async () => {
    const { database } = fixture;
    const sessionId = sessionIdOf(1);
    const otherSessionId = sessionIdOf(2);
    insertSession(database, sessionId, { name: "retry work" });
    insertSession(database, otherSessionId);
    insertEvent(database, {
      sessionId: otherSessionId,
      sequence: 0,
      type: "user.message",
      message: "retry",
    });
    // A row with no match and a thinking update, which the index never holds, among the matches,
    // each appended at the session's next sequence as the log appends them.
    const matchingRowIds: string[] = [];
    for (const sequence of [1, 2, 3, 4, 5, 6, 7]) {
      if (sequence === 4) {
        insertEvent(database, { sessionId, sequence, type: "user.message", message: "no match" });
      } else if (sequence === 7) {
        insertEvent(database, {
          sessionId,
          sequence,
          type: "assistant.thinking_update",
          content: "retry",
        });
      } else {
        matchingRowIds.push(
          insertEvent(database, {
            sessionId,
            sequence,
            type: "assistant.message",
            content: `attempt ${String(sequence)}: retry${", then retry".repeat(sequence % 3)}`,
          }),
        );
      }
    }
    await fixture.settle();
    const { transcriptSearch } = fixture.services();

    const firstPage = TranscriptSearchResponseSchema.parse(
      transcriptSearch.search({ sessionId, query: "retry", limit: 2 }),
    );
    expect(firstPage.hits[0]).toEqual({
      rowId: matchingRowIds[4],
      cursor: encodeEventCursor(6),
      snippet: "attempt 6: retry",
      matchRanges: [{ start: 11, end: 16 }],
    });
    const hits: TranscriptSearchHit[] = [...firstPage.hits];
    const matchCounts = [firstPage.matchCount];
    let page = firstPage;
    while (page.hasMore) {
      page = TranscriptSearchResponseSchema.parse(
        transcriptSearch.search({
          sessionId,
          query: "retry",
          limit: 2,
          beforeCursor: page.nextCursor,
        }),
      );
      hits.push(...page.hits);
      matchCounts.push(page.matchCount);
    }

    // The title is no row of the log, and the other session's row is not this session's.
    expect(hits.map((hit) => hit.rowId)).toEqual(matchingRowIds.toReversed());
    expect(hits.map((hit) => hit.cursor)).toEqual(
      [6, 5, 3, 2, 1].map((sequence) => encodeEventCursor(sequence)),
    );
    const markCount = hits.reduce((count, hit) => count + hit.matchRanges.length, 0);
    expect(markCount).toBe(1 + 3 + 1 + 3 + 2);
    expect(matchCounts).toEqual(matchCounts.map(() => markCount));
  });
});
