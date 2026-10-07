// A session's related list holds its linked sessions, ranked by a walk of at most two steps over
// the links: a linked session a second path also reaches outranks one reached by its link alone,
// a session reached only in two steps is left out, and an old link outranks a fresh one of its
// kind no longer. The scores are stored through the real writer and read back from the stored
// rows, and a rename reaches the lists that show the renamed session.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionRelatedListUpdate } from "@ai-sidekicks/contracts/session/links";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { openSessionLog } from "../../directory/__fixtures__/session-log.js";
import { mintSessionId, seedSessionRow } from "../../groups/__fixtures__/directory-rows.js";
import { recordedSessionLinkStatement } from "../../links/recorded.js";
import { SessionRelatedRanking, type SessionRelatedRankingOptions } from "../ranking.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let scratch: ScratchDatabase;
let ranking: SessionRelatedRanking;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  ranking = rankingOn(scratch);
});

function rankingOn(
  database: ScratchDatabase,
  events: SessionRelatedRankingOptions["events"] = { followAll: () => () => {} },
): SessionRelatedRanking {
  return new SessionRelatedRanking({
    reader: database.reader,
    writer: database.writer,
    events,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
    now: () => NOW,
  });
}

afterEach(async () => {
  await ranking.whenIdle();
  await scratch.close();
});

async function seedSessions(count: number): Promise<SessionId[]> {
  const sessionIds = Array.from({ length: count }, mintSessionId);
  for (const sessionId of sessionIds) {
    await seedSessionRow(scratch.writer, sessionId);
  }
  return sessionIds;
}

async function link(
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
  daysAgo = 0,
  database: ScratchDatabase = scratch,
  linkedRanking: SessionRelatedRanking = ranking,
): Promise<void> {
  await database.writer.write([
    recordedSessionLinkStatement({
      sourceSessionId,
      targetSessionId,
      kind: "started",
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    }),
  ]);
  linkedRanking.rescoreAround([sourceSessionId, targetSessionId]);
  await linkedRanking.whenIdle();
}

function storedScores(sessionId: SessionId): Map<string, number> {
  const rows = scratch.reader
    .prepare("SELECT related_session_id, score FROM session_related WHERE session_id = ?")
    .all(sessionId) as { related_session_id: string; score: number }[];
  return new Map(rows.map((row) => [row.related_session_id, row.score]));
}

describe("a session's related ranking", () => {
  it("raises a linked session a second path reaches, and stores no two-step-only one", async () => {
    const [planner, builder, reviewer, tester, farSession] = await seedSessions(5);
    await link(planner!, builder!);
    await link(planner!, reviewer!);
    await link(planner!, tester!);
    await link(builder!, reviewer!);
    await link(tester!, farSession!);

    // A third of the planner's walk goes to each linked session; the builder's walk sends half of
    // its third on to the reviewer and back, and a second step counts half. The tester's walk
    // reaches only the far session, which the planner has no link to.
    const scores = storedScores(planner!);
    expect([...scores.keys()].sort()).toEqual([builder, reviewer, tester].sort());
    expect(scores.get(builder!)).toBeCloseTo(1 / 3 + 0.5 * (1 / 3) * 0.5);
    expect(scores.get(reviewer!)).toBeCloseTo(1 / 3 + 0.5 * (1 / 3) * 0.5);
    expect(scores.get(tester!)).toBeCloseTo(1 / 3);
    expect(ranking.read(planner!).related.map((entry) => entry.sessionId)).toEqual([
      ...[builder, reviewer].sort(),
      tester,
    ]);
  });

  it("halves a link's weight with age, so an old link ranks below a fresh one of its kind", async () => {
    const [planner, oldBuilder, freshBuilder] = await seedSessions(3);
    await link(planner!, oldBuilder!, 60);
    await link(planner!, freshBuilder!);

    const scores = storedScores(planner!);
    expect(scores.get(freshBuilder!)).toBeGreaterThan(scores.get(oldBuilder!)!);
    expect(ranking.read(planner!).related.map((entry) => entry.sessionId)).toEqual([
      freshBuilder,
      oldBuilder,
    ]);
  });

  it("sends a follower the whole list at once and again after a link re-scores it", async () => {
    const [planner, builder, reviewer] = await seedSessions(3);
    await link(planner!, builder!);
    const updates: SessionRelatedListUpdate[] = [];
    const unfollow = ranking.follow(planner!, (update) => {
      updates.push(update);
    });

    await link(planner!, reviewer!);
    unfollow();
    await link(builder!, reviewer!);

    expect(updates.map((update) => update.related.map((entry) => entry.sessionId).sort())).toEqual([
      [builder],
      [builder, reviewer].sort(),
    ]);
  });
});

describe("a related list after a rename", () => {
  it("sends the new name to a follower of a session linked to the renamed one", async () => {
    const log = await openSessionLog();
    const loggedRanking = rankingOn(log.scratch, log.eventLog);
    const stop = loggedRanking.start();
    try {
      const [planner, builder] = [mintSessionId(), mintSessionId()];
      await log.createSession(planner, "project");
      await log.createSession(builder, "project");
      await link(planner, builder, 0, log.scratch, loggedRanking);
      const names: (string | undefined)[] = [];
      loggedRanking.follow(planner, (update) => {
        names.push(update.related[0]?.name);
      });

      await log.append(builder, "session.renamed", "session_lifecycle", {
        sessionId: builder,
        name: "Builder",
        origin: "user",
      });
      await loggedRanking.whenIdle();

      expect(names).toEqual([undefined, "Builder"]);
    } finally {
      stop();
      await loggedRanking.whenIdle();
      await log.scratch.close();
    }
  });
});
