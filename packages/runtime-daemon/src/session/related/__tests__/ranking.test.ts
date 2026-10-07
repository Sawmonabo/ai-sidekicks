// A session's related list is ranked by a walk of at most two steps over its links: a direct
// link outranks a two-step path, and an old link outranks a fresh one of its kind no longer. The
// scores are stored through the real writer and read back from the stored rows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionRelatedListUpdate } from "@ai-sidekicks/contracts/session/links";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { mintSessionId, seedSessionRow } from "../../groups/__fixtures__/directory-rows.js";
import { recordedSessionLinkStatement } from "../../links/recorded.js";
import { SessionRelatedRanking } from "../ranking.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let scratch: ScratchDatabase;
let ranking: SessionRelatedRanking;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  ranking = new SessionRelatedRanking({
    reader: scratch.reader,
    writer: scratch.writer,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
    now: () => NOW,
  });
});

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
): Promise<void> {
  await scratch.writer.write([
    recordedSessionLinkStatement({
      sourceSessionId,
      targetSessionId,
      kind: "started",
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    }),
  ]);
  ranking.rescoreAround([sourceSessionId, targetSessionId]);
  await ranking.whenIdle();
}

function storedScores(sessionId: SessionId): Map<string, number> {
  const rows = scratch.reader
    .prepare("SELECT related_session_id, score FROM session_related WHERE session_id = ?")
    .all(sessionId) as { related_session_id: string; score: number }[];
  return new Map(rows.map((row) => [row.related_session_id, row.score]));
}

describe("a session's related ranking", () => {
  it("scores a session two steps away at half a step's share, below a direct one", async () => {
    const [planner, builder, reviewer] = await seedSessions(3);
    await link(planner!, builder!);
    await link(builder!, reviewer!);

    // The planner's walk goes all to the builder, and half of the builder's on to the reviewer;
    // a second step counts half.
    const scores = storedScores(planner!);
    expect(scores.get(builder!)).toBeCloseTo(1);
    expect(scores.get(reviewer!)).toBeCloseTo(0.5 * 1 * 0.5);
    expect(scores.has(planner!)).toBe(false);
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
