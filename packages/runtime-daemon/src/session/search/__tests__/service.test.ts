// `session.search` over the search index the outbox feeds: every page holds the hits an FTS5 index
// ranks over the same rows, in its order, after every write a searchable row takes and after a
// purge, whose rows leave the other sessions' scores as an index built without them gives; and a
// tag keeps the sessions carrying it or one nested under it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { START_OF_LOG_POSITION, encodeEventCursor } from "@ai-sidekicks/contracts/session/id";

import { insertEvent, insertSession, insertTag, sessionIdOf } from "../__fixtures__/index-rows.js";
import {
  hitsByQuery,
  readEveryHit,
  referenceHitsByQuery,
} from "../__fixtures__/reference-ranking.js";
import { SearchFixture } from "../__fixtures__/search-services.js";
import { SeededDirectory } from "../__fixtures__/seeded-directory.js";

const SESSION_START = encodeEventCursor(START_OF_LOG_POSITION);

describe("session.search", () => {
  let fixture: SearchFixture;

  beforeEach(async () => {
    fixture = await SearchFixture.open();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("pages every hit an FTS5 index ranks, through each write a row takes and a purge", async () => {
    const directory = new SeededDirectory(fixture.database);
    directory.seed(40);
    await fixture.settle();
    const search = fixture.services().sessionSearch;

    expect(hitsByQuery((request) => search.search(request))).toEqual(
      referenceHitsByQuery(directory.rows()),
    );

    // A title given and one cleared, a session moved into a group and one out, a tag taken off,
    // purges, the newest session's among them, whose rowids the next session and message take, and
    // a message appended.
    directory.rename(sessionIdOf(3), "deploy café notes");
    directory.rename(sessionIdOf(2), null);
    directory.moveToGroup(sessionIdOf(4), "group-2");
    directory.moveToGroup(sessionIdOf(5), undefined);
    directory.removeTag(sessionIdOf(1), "billing/stripe");
    for (const index of [7, 8, 40]) {
      directory.purge(sessionIdOf(index));
    }
    directory.addSession(sessionIdOf(41), "release notes", "deploy the billing worker");
    directory.addMessage(sessionIdOf(6), "retry the webhook deploy");
    await fixture.settle();

    expect(hitsByQuery((request) => search.search(request))).toEqual(
      referenceHitsByQuery(directory.rows()),
    );
  });

  it("keeps the sessions carrying a tag or one nested under it, alone or ranked with words", async () => {
    // Shorter text ranks better; a tag ranks the most recently active first. Each order differs.
    const sessions = [
      { index: 1, message: "auth", lastActivityAt: "2026-10-02T00:00:00.000Z", tag: "billing" },
      {
        index: 2,
        message: "auth x y",
        lastActivityAt: "2026-10-01T00:00:00.000Z",
        tag: "Billing/Stripe",
      },
      {
        index: 3,
        message: "auth x y z w v",
        lastActivityAt: "2026-10-03T00:00:00.000Z",
        tag: "billing/stripe",
      },
      { index: 4, message: "auth", lastActivityAt: "2026-10-04T00:00:00.000Z", tag: "billingx" },
    ];
    for (const { index, message, lastActivityAt, tag } of sessions) {
      insertSession(fixture.database, sessionIdOf(index), { lastActivityAt });
      insertEvent(fixture.database, {
        sessionId: sessionIdOf(index),
        sequence: 1,
        type: "user.message",
        message,
      });
      insertTag(fixture.database, sessionIdOf(index), tag);
    }
    await fixture.settle();
    const search = fixture.services().sessionSearch;

    // By tag alone, most recently active first, ignoring case and never a longer tag.
    expect(search.search({ query: "tag:BILLING" })).toEqual({
      groups: [
        {
          sessionId: sessionIdOf(3),
          hits: [
            { cursor: SESSION_START, line: "billing/stripe", matchRanges: [{ start: 0, end: 7 }] },
          ],
        },
        {
          sessionId: sessionIdOf(1),
          hits: [{ cursor: SESSION_START, line: "billing", matchRanges: [{ start: 0, end: 7 }] }],
        },
        {
          sessionId: sessionIdOf(2),
          hits: [
            { cursor: SESSION_START, line: "Billing/Stripe", matchRanges: [{ start: 0, end: 7 }] },
          ],
        },
      ],
      hasMore: false,
    });
    // With words, only the tagged sessions' rows rank: text rank 1, 2, 3 and tag rank 2, 3, 1 fuse
    // to 1, 3, 2, and each session's hits are its words' hits, a page at a time.
    const byTagAndWords = readEveryHit((request) => search.search(request), {
      query: "tag:billing auth",
      limit: 1,
    });
    expect(byTagAndWords.map((hit) => hit.sessionId)).toEqual([
      sessionIdOf(1),
      sessionIdOf(3),
      sessionIdOf(2),
    ]);
    expect(byTagAndWords.map((hit) => hit.line)).toEqual(["auth", "auth x y z w v", "auth x y"]);
  });
});
