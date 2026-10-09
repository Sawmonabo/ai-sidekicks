// `transcript.search` over one session's rows in the search index: paged newest first, one hit per
// row, every page counting every match in the session, which is the sum of the marks its hits
// carry; a damaged session is searched and counted before its last good point alone; a row whose
// payload damage left unreadable is never indexed, and a range its session skipped past as damaged
// leaves the index, whether the index applies the skip or is built again; and a deleted row whose
// rowid another session's row takes before the index applies either is no hit, so every page stays
// in the session's own log.

import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  TranscriptSearchResponseSchema,
  type TranscriptSearchHit,
  type TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import { insertEvent, insertSession, sessionIdOf } from "../__fixtures__/index-rows.js";
import { SearchFixture } from "../__fixtures__/services.js";

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

  it("counts and shows only the rows before a damaged session's last good point", async () => {
    const { database } = fixture;
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId);
    // The row at each sequence says "retry" one time more than the row before it.
    const rowIds = [0, 1, 2, 3].map((sequence) =>
      insertEvent(database, {
        sessionId,
        sequence,
        type: "user.message",
        message: Array.from({ length: sequence + 1 }, () => "retry").join(" "),
      }),
    );
    await fixture.settle();
    const { transcriptSearch } = fixture.services();
    // The history is damaged from sequence 2 on, so reads stop after sequence 1.
    const searchBeforeDamage = (beforeSequence?: number): TranscriptSearchResponse =>
      transcriptSearch.search(
        {
          sessionId,
          query: "retry",
          limit: 1,
          ...(beforeSequence === undefined
            ? {}
            : { beforeCursor: encodeEventCursor(beforeSequence) }),
        },
        2,
      );

    const firstPage = searchBeforeDamage();
    expect(firstPage).toMatchObject({ matchCount: 1 + 2, hasMore: true });
    expect(firstPage.hits.map((hit) => hit.rowId)).toEqual([rowIds[1]]);
    // A cursor past the damaged point reads from it, as the first page does.
    expect(searchBeforeDamage(4).hits.map((hit) => hit.rowId)).toEqual([rowIds[1]]);
    const lastPage = searchBeforeDamage(1);
    expect(lastPage).toMatchObject({ matchCount: 1 + 2, hasMore: false });
    expect(lastPage.hits.map((hit) => hit.rowId)).toEqual([rowIds[0]]);
  });

  it("keeps every page in the session's own log once a deleted row's rowid is taken", async () => {
    const { database } = fixture;
    const sessionId = sessionIdOf(1);
    const otherSessionId = sessionIdOf(2);
    insertSession(database, sessionId);
    insertSession(database, otherSessionId);
    const rowIds = [0, 1, 2, 3].map((sequence) =>
      insertEvent(database, {
        sessionId,
        sequence,
        type: "user.message",
        message: `retry ${String(sequence)}`,
      }),
    );
    await fixture.settle();
    // The session's newest row goes, and the other session's next row takes its rowid, before the
    // index applies either.
    const rowidOf = (eventId: string | undefined): unknown =>
      database.prepare("SELECT rowid FROM session_events WHERE id = ?").pluck().get(eventId);
    const deletedRowid = rowidOf(rowIds[3]);
    database.prepare("DELETE FROM session_events WHERE id = ?").run(rowIds[3]);
    const otherRowId = insertEvent(database, {
      sessionId: otherSessionId,
      sequence: 0,
      type: "user.message",
      message: "retry elsewhere",
    });
    expect(rowidOf(otherRowId)).toBe(deletedRowid);
    const { transcriptSearch } = fixture.services();

    let page = transcriptSearch.search({ sessionId, query: "retry", limit: 1 });
    const pages = [page];
    while (page.hasMore) {
      page = transcriptSearch.search({
        sessionId,
        query: "retry",
        limit: 1,
        beforeCursor: page.nextCursor,
      });
      pages.push(page);
    }

    expect(pages.flatMap(({ hits }) => hits.map((hit) => hit.rowId))).toEqual(
      rowIds.slice(0, 3).toReversed(),
    );
    expect(pages.map(({ matchCount }) => matchCount)).toEqual([3, 3, 3]);
  });

  it("never counts an unreadable row or a skipped range, applied or built again", async () => {
    const { database } = fixture;
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId);
    const firstRowId = insertEvent(database, {
      sessionId,
      sequence: 0,
      type: "user.message",
      message: "retry the deploy",
    });
    insertEvent(database, { sessionId, sequence: 1, type: "user.message", payload: "not json" });
    insertEvent(database, {
      sessionId,
      sequence: 2,
      type: "assistant.message",
      content: "retry once more",
    });
    const lastRowId = insertEvent(database, {
      sessionId,
      sequence: 3,
      type: "assistant.message",
      content: "retry again",
    });
    await fixture.settle();
    const answer = (): { matchCount: number; rowIds: string[] } => {
      const page = fixture.services().transcriptSearch.search({ sessionId, query: "retry" });
      return { matchCount: page.matchCount, rowIds: page.hits.map((hit) => hit.rowId) };
    };
    expect(answer().matchCount).toBe(3);

    // The session continues past sequences 1 and 2, the second readable until then.
    insertEvent(database, {
      sessionId,
      sequence: 4,
      type: "recovery.damaged_events_skipped",
      payload: JSON.stringify({ sessionId, fromSequence: 1, toSequence: 2 }),
    });
    await fixture.settle();
    const kept = { matchCount: 2, rowIds: [lastRowId, firstRowId] };
    expect(answer()).toEqual(kept);

    const builtAgain = await fixture.reopen(async () => {
      await rm(fixture.indexFolderPath, { recursive: true, force: true });
    });
    expect(builtAgain.rebuildReason).toBe("missing");
    expect(answer()).toEqual(kept);
  });
});
