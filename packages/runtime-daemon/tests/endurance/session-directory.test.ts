// Tier: endurance. The session directory's budgets, measured on the seeded set through the paths
// the daemon serves them on: every search class's first page and next page on the search thread,
// how long a search holds the daemon's main thread, and a stored related list's read. It prints
// p50 and p95 per class against each budget, with the test process's resident memory beside them,
// and fails on any class over one.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  SessionSearchCursor,
  SessionSearchRequest,
} from "@ai-sidekicks/contracts/session/methods";

import {
  closeDatabaseConnections,
  openDatabaseConnections,
  type DatabaseConnections,
} from "../../src/database/connections.js";
import { SessionLinkService } from "../../src/session/links/service.js";
import { SessionRelatedRanking } from "../../src/session/related/ranking.js";
import { SearchThread } from "../../src/session/search/thread/handle.js";
import { SEEDED_SET_SIZE, seedDirectorySet, type SeededSet } from "./seeded-set.js";

// A search, its first page or a later one, answers within this at p95.
const SEARCH_P95_BUDGET_MS = 50;
// No turn of the daemon's main thread a search takes runs longer than this on the thread itself.
const MAIN_THREAD_TURN_BUDGET_MS = 5;
// A session's stored related list reads within this at p95.
const RELATED_LIST_P95_BUDGET_MS = 1;

// Runs per measurement, fewer for a query whose run takes long, so a run stays within minutes;
// twenty still leave the 95th percentile below the slowest run.
const RUNS = 40;
const SLOW_QUERY_RUNS = 20;
const SLOW_QUERY_MS = 200;
const RELATED_LIST_READS = 2_000;
const RESCORED_LINKS = 50;

// What the writer and the related ranking report: a failed write or re-score voids the numbers.
const serviceLogLines: string[] = [];
function writeServiceLog(line: string): void {
  serviceLogLines.push(line);
}

interface Timing {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

// The main thread's longest turn while a measurement ran, and how late its timer fired at most.
interface MainThreadTurns {
  readonly longestTurnMs: number;
  readonly longestLatenessMs: number;
}

// One line of the printed table, and whether its numbers are inside their budgets.
interface MeasuredClass {
  readonly label: string;
  readonly line: string;
  readonly misses: readonly string[];
}

function timingOf(durationsMs: readonly number[]): Timing {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const at = (percent: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0;
  return { p50Ms: at(50), p95Ms: at(95) };
}

function formatTiming(timing: Timing): string {
  return `${timing.p50Ms.toFixed(1)}/${timing.p95Ms.toFixed(1)} ms`;
}

function formatTurns(turns: MainThreadTurns): string {
  return (
    `longest main-thread turn ${turns.longestTurnMs.toFixed(1)} ms ` +
    `(timer ${turns.longestLatenessMs.toFixed(1)} ms late at most)`
  );
}

function residentMemory(): string {
  return `resident ${(process.memoryUsage.rss() / 2 ** 20).toFixed(0)} MiB`;
}

// Follows the main thread's turns until the returned stop. A turn is timed by the thread's own CPU
// time: a 1 ms tick reads it, so a turn that holds the thread shows whole at the next tick, while a
// wait for a core on a busy machine, which delays the tick without the thread running, does not.
// How late the tick's timer fired, which counts those waits too, is reported beside it.
function followMainThreadTurns(): () => MainThreadTurns {
  const lateness = monitorEventLoopDelay({ resolution: 1 });
  let longestTurnMs = 0;
  let lastCpu = process.threadCpuUsage();
  const readTurn = (): void => {
    const cpu = process.threadCpuUsage();
    const turnMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    longestTurnMs = Math.max(longestTurnMs, turnMs);
    lastCpu = cpu;
  };
  const ticker = setInterval(readTurn, 1);
  lateness.enable();
  return () => {
    lateness.disable();
    clearInterval(ticker);
    readTurn();
    return { longestTurnMs, longestLatenessMs: lateness.max / 1e6 };
  };
}

// Times `run` repeatedly after one untimed run that warms the caches, fewer times once one run is
// slow, and reports the main thread's turns meanwhile.
async function measure(run: () => Promise<unknown>): Promise<Timing & MainThreadTurns> {
  await run();
  const stopFollowingTurns = followMainThreadTurns();
  const durationsMs: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now();
    await run();
    durationsMs.push(performance.now() - start);
    if (index === 0 && durationsMs[0] !== undefined && durationsMs[0] > SLOW_QUERY_MS) {
      for (let slowIndex = 1; slowIndex < SLOW_QUERY_RUNS; slowIndex += 1) {
        const slowStart = performance.now();
        await run();
        durationsMs.push(performance.now() - slowStart);
      }
      break;
    }
  }
  return { ...timingOf(durationsMs), ...stopFollowingTurns() };
}

describe("the session directory's budgets on the seeded set", () => {
  let folder: string;
  let database: DatabaseConnections;
  let seeded: SeededSet;
  let searchThread: SearchThread;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "directory-budgets-"));
    const databasePath = join(folder, "daemon.db");
    database = await openDatabaseConnections({ databasePath, writeServiceLog });
    seeded = await seedDirectorySet(database);
    // Measured as an idle daemon leaves the index, merged into one tree as `optimize` merges it,
    // and read from the main file.
    await database.writer.write([
      { sql: "INSERT INTO session_search_index (session_search_index) VALUES ('optimize')" },
    ]);
    await database.writer.checkpoint("TRUNCATE");
    // The seeding leaves this thread's heap large and mostly garbage, which the daemon's main
    // thread never holds; collected and given back now, no collection of it lands in a measured
    // turn.
    if (gc === undefined) {
      throw new Error("The endurance tier runs with --expose-gc, which its project sets.");
    }
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
    searchThread = SearchThread.start(databasePath);
  });

  afterAll(async () => {
    await searchThread.close();
    await closeDatabaseConnections(database);
    await rm(folder, { recursive: true, force: true });
  });

  it("answers each search class within budget without holding the main thread", async () => {
    const { words } = seeded;
    const word = (rank: number): string => words[rank] ?? "";
    // The nested tag the most sessions carry, still a few of them.
    const narrowTag = database.reader
      .prepare<[], string>(
        `SELECT tag FROM session_tags WHERE tag_folded LIKE 'billing/%'
          GROUP BY tag_folded ORDER BY count(*) DESC, tag_folded LIMIT 1`,
      )
      .pluck()
      .get();
    if (narrowTag === undefined) {
      throw new Error("The seeded set holds no nested tag under billing.");
    }
    const sessionQueries: readonly (readonly [string, string])[] = [
      ["rare word", word(15_000)],
      ["mid word", word(2_000)],
      ["common word", word(100)],
      ["most common word", word(0)],
      ["two words", `${word(300)} ${word(400)}`],
      ["four letters as typed", word(700).slice(0, 4)],
      ["tag alone", "tag:billing"],
      ["tag and mid word", `tag:billing ${word(2_000)}`],
      ["tag and common word", `tag:billing ${word(100)}`],
      ["narrow tag and most common word", `tag:${narrowTag} ${word(0)}`],
      ["group name word", "work"],
    ];
    const measured: MeasuredClass[] = [];
    for (const [label, query] of sessionQueries) {
      const request: SessionSearchRequest = { query };
      const firstPage = await measure(() => searchThread.searchSessions(request));
      // A later page continues one held search; each run reads the same page from its cursor.
      const opened = await searchThread.searchSessions(request);
      const nextCursor: SessionSearchCursor | undefined = opened.hasMore
        ? opened.nextCursor
        : undefined;
      const nextPage =
        nextCursor === undefined
          ? undefined
          : await measure(() => searchThread.searchSessions({ query, afterCursor: nextCursor }));
      const misses = [
        ...(firstPage.p95Ms > SEARCH_P95_BUDGET_MS ? ["first page"] : []),
        ...(nextPage !== undefined && nextPage.p95Ms > SEARCH_P95_BUDGET_MS ? ["next page"] : []),
        ...[firstPage, nextPage]
          .filter((timing) => (timing?.longestTurnMs ?? 0) > MAIN_THREAD_TURN_BUDGET_MS)
          .map(() => "main thread"),
      ];
      const turns: MainThreadTurns = {
        longestTurnMs: Math.max(firstPage.longestTurnMs, nextPage?.longestTurnMs ?? 0),
        longestLatenessMs: Math.max(firstPage.longestLatenessMs, nextPage?.longestLatenessMs ?? 0),
      };
      measured.push({
        label,
        line:
          `${label.padEnd(32)} ${JSON.stringify(query).padEnd(24)} ` +
          `first ${formatTiming(firstPage)}` +
          `  next ${nextPage === undefined ? "none" : formatTiming(nextPage)}` +
          `  ${formatTurns(turns)}  ${residentMemory()}`,
        misses,
      });
    }
    for (const [sessionLabel, sessionId] of [
      ["typical session", seeded.typicalSessionId],
      ["large session", seeded.largeSessionId],
    ] as const) {
      for (const [label, query] of [
        ["rare word", word(15_000)],
        ["mid word", word(2_000)],
        ["most common word", word(0)],
      ] as const) {
        const page = await measure(() =>
          searchThread.searchTranscript({ sessionId: sessionId as SessionId, query }),
        );
        measured.push({
          label: `transcript, ${sessionLabel}, ${label}`,
          line:
            `transcript ${sessionLabel} ${label}`.padEnd(45) +
            ` ${formatTiming(page)}  ${formatTurns(page)}  ${residentMemory()}`,
          misses: [
            ...(page.p95Ms > SEARCH_P95_BUDGET_MS ? ["page"] : []),
            ...(page.longestTurnMs > MAIN_THREAD_TURN_BUDGET_MS ? ["main thread"] : []),
          ],
        });
      }
    }
    console.log(
      `Search on ${String(SEEDED_SET_SIZE.sessions)} sessions, ` +
        `${String(SEEDED_SET_SIZE.messages)} messages and ${String(SEEDED_SET_SIZE.tags)} tags ` +
        `(p50/p95; budget ${String(SEARCH_P95_BUDGET_MS)} ms at p95, main-thread turn ` +
        `${String(MAIN_THREAD_TURN_BUDGET_MS)} ms; the test process's memory after each):\n` +
        measured.map((entry) => `  ${entry.line}`).join("\n") +
        `\n  peak resident ${(process.resourceUsage().maxRSS / 2 ** 10).toFixed(0)} MiB`,
    );
    expect(
      measured
        .filter((entry) => entry.misses.length > 0)
        .map((entry) => `${entry.label}: ${entry.misses.join(", ")}`),
    ).toEqual([]);
  });

  it("reads a session's stored related list within budget", async () => {
    const ranking = new SessionRelatedRanking({
      reader: database.reader,
      writer: database.writer,
      events: { followAll: () => () => {} },
      writeServiceLog,
    });
    const { sessionIds } = seeded;
    const sessionAt = (index: number): SessionId =>
      sessionIds[index % sessionIds.length] as SessionId;
    ranking.rescoreAround(sessionIds as SessionId[]);
    await ranking.whenIdle();
    const readsMs: number[] = [];
    for (let index = 0; index < RELATED_LIST_READS; index += 1) {
      const sessionId = sessionAt(index * 7_919);
      const start = performance.now();
      ranking.read(sessionId);
      readsMs.push(performance.now() - start);
    }
    // A new link re-scores its two sessions and their neighbors in the background.
    const links = new SessionLinkService({
      reader: database.reader,
      writer: database.writer,
      relatedRanking: ranking,
    });
    const stopFollowingTurns = followMainThreadTurns();
    const rescoresMs: number[] = [];
    for (let index = 0; index < RESCORED_LINKS; index += 1) {
      await links.add({
        sessionId: sessionAt(index * 31),
        targetSessionId: sessionAt(index * 97 + 1),
      });
      const start = performance.now();
      await ranking.whenIdle();
      rescoresMs.push(performance.now() - start);
    }
    const turns = stopFollowingTurns();
    const read = timingOf(readsMs);
    const rescore = timingOf(rescoresMs);
    console.log(
      `Related list on ${String(SEEDED_SET_SIZE.sessions)} sessions and ` +
        `${String(SEEDED_SET_SIZE.links)} links (p50/p95): read ${read.p50Ms.toFixed(3)}/` +
        `${read.p95Ms.toFixed(3)} ms, budget ${String(RELATED_LIST_P95_BUDGET_MS)} ms at p95; ` +
        `re-score after one new link ${formatTiming(rescore)} in the background, ` +
        `${formatTurns(turns)}; ${residentMemory()}`,
    );
    expect(serviceLogLines).toEqual([]);
    expect(read.p95Ms).toBeLessThanOrEqual(RELATED_LIST_P95_BUDGET_MS);
  });
});
