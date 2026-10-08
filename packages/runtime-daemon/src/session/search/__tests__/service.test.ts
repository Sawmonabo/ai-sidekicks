// `session.search` over the search index the outbox feeds: every page holds the hits an FTS5 index
// ranks over the same rows, in its order, within the sessions a tag keeps when the query names
// one, after every write a searchable row takes and after a purge, whose rows leave the other
// sessions' scores as an index built without them gives; and a search by tag alone orders the
// tagged sessions most recently active first as their activity moves.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { START_OF_LOG_POSITION, encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import type { SessionSearchHit } from "@ai-sidekicks/contracts/session/methods";

import { insertSession, insertTag, sessionIdOf } from "../__fixtures__/index-rows.js";
import { hitsByQuery, referenceHitsByQuery } from "../__fixtures__/reference-ranking.js";
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

  it("orders a search by tag alone most recently active first, as each session's activity moves", async () => {
    const sessions = [
      { index: 1, lastActivityAt: "2026-10-02T00:00:00.000Z", tag: "billing" },
      { index: 2, lastActivityAt: "2026-10-01T00:00:00.000Z", tag: "Billing/Stripe" },
      { index: 3, lastActivityAt: "2026-10-03T00:00:00.000Z", tag: "billing/stripe" },
      { index: 4, lastActivityAt: "2026-10-04T00:00:00.000Z", tag: "billingx" },
    ];
    for (const { index, lastActivityAt, tag } of sessions) {
      insertSession(fixture.database, sessionIdOf(index), { lastActivityAt });
      insertTag(fixture.database, sessionIdOf(index), tag);
    }
    await fixture.settle();
    const search = fixture.services().sessionSearch;
    const tagHit = (line: string): SessionSearchHit => ({
      cursor: SESSION_START,
      line,
      matchRanges: [{ start: 0, end: 7 }],
    });

    // Ignoring case, nested tags included and never a longer tag.
    expect(search.search({ query: "tag:BILLING" })).toEqual({
      groups: [
        { sessionId: sessionIdOf(3), hits: [tagHit("billing/stripe")] },
        { sessionId: sessionIdOf(1), hits: [tagHit("billing")] },
        { sessionId: sessionIdOf(2), hits: [tagHit("Billing/Stripe")] },
      ],
      hasMore: false,
    });

    fixture.database
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
      .run("2026-10-05T00:00:00.000Z", sessionIdOf(2));
    await fixture.settle();
    expect(search.search({ query: "tag:billing" }).groups.map((group) => group.sessionId)).toEqual([
      sessionIdOf(2),
      sessionIdOf(3),
      sessionIdOf(1),
    ]);
  });
});
