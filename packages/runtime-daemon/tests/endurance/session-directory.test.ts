// Tier: endurance. The session directory's budgets, measured on the seeded set through the paths
// the daemon serves them on: the search index's full build from the database at the built daemon's
// start and the peak footprint of the daemon and its build process together, the index's merges,
// every search class's first page and next page on the search thread, the probe queries, a find
// in the largest session, how long a search holds the daemon's main thread, the
// wait from a settled message to its first hit, a stored related list's read, how long a re-score
// after a new link holds the main thread, and a search right after the largest session's purge.
// It prints p50 and p95 per class against each budget, with the test process's resident memory
// beside them, and fails on any class over one. The build runs in the built daemon, `dist/main.js`,
// so `pnpm build` runs first.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NodeIdSchema } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  SessionSearchCursor,
  SessionSearchRequest,
} from "@ai-sidekicks/contracts/session/methods";

import {
  closeDatabaseConnections,
  openDatabaseConnections,
  type DatabaseConnections,
} from "../../src/database/connection/lifecycle.js";
import {
  DATABASE_FILE_NAME,
  resolveDataFolder,
  SEARCH_INDEX_FOLDER_NAME,
} from "../../src/daemon/process.js";
import { SessionPurge } from "../../src/events/session/purge.js";
import { KeyedLock } from "../../src/keyed-lock.js";
import { SessionLinkService } from "../../src/session/links/service.js";
import { SessionRelatedRanking } from "../../src/session/related/ranking.js";
import { SearchThread } from "../../src/session/search/thread/handle.js";
import { mintUuidV7 } from "../../src/uuid-v7.js";
import { loadProcessMemoryReader } from "./process-memory.js";
import { SEEDED_SET_SIZE, seedDirectorySet, type SeededSet } from "./seeded-set.js";

// A search, its first page or a later one, answers within this at p95.
const SEARCH_P95_BUDGET_MS = 50;
// No turn of the daemon's main thread a search takes runs longer than this on the thread itself.
const MAIN_THREAD_TURN_BUDGET_MS = 5;
// A session's stored related list reads within this at p95.
const RELATED_LIST_P95_BUDGET_MS = 1;
// The search index's full build from the database finishes within this, and the footprint of the
// daemon and its build process together stays within this meanwhile.
const REBUILD_BUDGET_MS = 60_000;
const REBUILD_FOOTPRINT_BUDGET_MIB = 350;
// One merge of the index's segments finishes within this.
const MERGE_BUDGET_MS = 3_000;
// A settled message is found by a search within this of its commit.
const SETTLED_TO_HIT_BUDGET_MS = 1_000;

// Runs per measurement, fewer for a query whose run takes long, so a run stays within minutes;
// twenty still leave the 95th percentile below the slowest run.
const RUNS = 40;
const SLOW_QUERY_RUNS = 20;
const SLOW_QUERY_MS = 200;
const RELATED_LIST_READS = 2_000;
const RESCORED_LINKS = 50;
const SETTLED_MESSAGES = 20;
// The probe queries the index was chosen on, each as the search box sends it: letters as typed,
// prefixes of four and five letters, words, two words, a tag and a nested tag with a word.
const PROBE_QUERIES = [
  "l",
  "lo",
  "lope",
  "lopek",
  "nezin",
  "blemi",
  "nezi",
  "lo kalo",
  "nezi lo",
  "tag:billing nezi",
  "tag:billing/mitalo lo",
  "neblegrivo",
];
// How often the daemon's and its children's memory is read while the index builds.
const MEMORY_SAMPLE_MS = 50;
// How often a wait for an index change asks again, and when it gives up.
const POLL_INTERVAL_MS = 5;
const POLL_LIMIT_MS = 10_000;
// A merge loop that never reports the index merged fails rather than running on.
const MERGES_AT_MOST = 1_000;

// What the writer and the related ranking report: a failed write or re-score voids the numbers.
const serviceLogLines: string[] = [];
function writeServiceLog(line: string): void {
  serviceLogLines.push(line);
}
// What the test's own search thread reports: nothing, since it opens the index the daemon built.
const searchLogLines: string[] = [];

// The built daemon, run as a person runs it, so the build's footprint is its processes' own.
const DAEMON_ENTRY = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
// What the daemon's search thread logs once it has built the index and answers searches.
const INDEX_REBUILT_LINE = "search_index_rebuilt: missing";

interface Timing {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

// The main thread's longest turn while a measurement ran, and how late its timer fired at most.
interface MainThreadTurns {
  readonly longestTurnMs: number;
  readonly longestLatenessMs: number;
}

// The index's build at the daemon's start: its time, the daemon's lifetime peak footprint, how many
// processes it started and the sum of their peaks, and the most the daemon and they held at once
// in a sample.
interface DaemonBuild {
  readonly buildMs: number;
  readonly daemonPeakMiB: number;
  readonly childCount: number;
  readonly childrenPeakMiB: number;
  readonly sampledPeakMiB: number;
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

// The index's build in a daemon started on `homeFolder`, whose data folder holds the database and
// no index: how long from the spawn until its search thread answers, and the peak footprints by
// then of the daemon and of the processes it started, each child's read last while it ran. The
// daemon is stopped before this resolves, or once `signal` aborts; throws, with what it printed,
// when it exits before the build.
async function buildIndexInDaemon(
  homeFolder: string,
  runFolder: string,
  signal: AbortSignal,
): Promise<DaemonBuild> {
  const memory = await loadProcessMemoryReader();
  const startedAt = performance.now();
  const daemon = spawn(process.execPath, [DAEMON_ENTRY], {
    env: { ...process.env, HOME: homeFolder, XDG_RUNTIME_DIR: runFolder },
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let output = "";
  const exited = new Promise<void>((resolve) => {
    daemon.once("exit", () => {
      resolve();
    });
    daemon.once("error", (error) => {
      output += `${error.message}\n`;
      resolve();
    });
  });
  const built = new Promise<void>((resolve) => {
    for (const stream of [daemon.stdout, daemon.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.includes(INDEX_REBUILT_LINE)) {
          resolve();
        }
      });
    }
  });
  const childPeakBytes = new Map<number, number>();
  let sampledPeakBytes = 0;
  let isSampling = true;
  const sampling = (async (): Promise<void> => {
    const daemonId = daemon.pid;
    while (isSampling && daemonId !== undefined) {
      let togetherBytes = (await memory.readMemory(daemonId))?.currentBytes ?? 0;
      for (const childId of await memory.listChildren(daemonId)) {
        const child = await memory.readMemory(childId);
        if (child !== undefined) {
          togetherBytes += child.currentBytes;
          childPeakBytes.set(childId, Math.max(child.peakBytes, childPeakBytes.get(childId) ?? 0));
        }
      }
      sampledPeakBytes = Math.max(sampledPeakBytes, togetherBytes);
      await delay(MEMORY_SAMPLE_MS);
    }
  })();
  try {
    const isBuilt = await Promise.race([built.then(() => true), exited.then(() => false)]);
    const buildMs = performance.now() - startedAt;
    isSampling = false;
    await sampling;
    const daemonMemory = daemon.pid === undefined ? undefined : await memory.readMemory(daemon.pid);
    if (!isBuilt || daemonMemory === undefined) {
      throw new Error(`The daemon exited before it built the index:\n${output}`);
    }
    const childrenPeakBytes = [...childPeakBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    return {
      buildMs,
      daemonPeakMiB: daemonMemory.peakBytes / 2 ** 20,
      childCount: childPeakBytes.size,
      childrenPeakMiB: childrenPeakBytes / 2 ** 20,
      sampledPeakMiB: sampledPeakBytes / 2 ** 20,
    };
  } finally {
    isSampling = false;
    daemon.kill("SIGTERM");
    await exited;
  }
}

// How long until `isDone` answers true, asking every few milliseconds; throws once it has waited
// past the limit.
async function timeUntil(isDone: () => Promise<boolean>): Promise<number> {
  const start = performance.now();
  while (!(await isDone())) {
    if (performance.now() - start > POLL_LIMIT_MS) {
      throw new Error(`The change did not reach the index within ${String(POLL_LIMIT_MS)} ms.`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  return performance.now() - start;
}

describe("the session directory's budgets on the seeded set", () => {
  let database: DatabaseConnections;
  let seeded: SeededSet;
  let searchThread: SearchThread;
  let daemonBuild: DaemonBuild;
  // Stops the daemon at the end even when the build outlives the hook's time, so it never runs on
  // with no parent.
  const daemonStop = new AbortController();
  // What the start opened so far, undone last first at the end, however far a failed start got.
  const teardown: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    const folder = await mkdtemp(join(tmpdir(), "directory-budgets-"));
    teardown.push(() => rm(folder, { recursive: true, force: true }));
    // A socket's path is bounded, 104 bytes on macOS, so the daemon's run folder is a short one.
    const runFolder = await mkdtemp(join(tmpdir(), "budgets-run-"));
    teardown.push(() => rm(runFolder, { recursive: true, force: true }));
    const homeFolder = join(folder, "home");
    const dataFolder = resolveDataFolder(homeFolder);
    await mkdir(dataFolder, { recursive: true, mode: 0o700 });
    const databasePath = join(dataFolder, DATABASE_FILE_NAME);
    const seeding = await openDatabaseConnections({ databasePath, writeServiceLog });
    seeded = await seedDirectorySet(seeding);
    // Read from the main file, as an idle daemon leaves it.
    await seeding.writer.checkpoint("TRUNCATE");
    await closeDatabaseConnections(seeding);
    // No index folder yet, so the daemon's search thread builds the index from every row before
    // its first answer; the first test reads the build's time and footprint.
    daemonBuild = await buildIndexInDaemon(homeFolder, runFolder, daemonStop.signal);
    database = await openDatabaseConnections({ databasePath, writeServiceLog });
    teardown.push(() => closeDatabaseConnections(database));
    // The seeding leaves this thread's heap large and mostly garbage, which the daemon's main
    // thread never holds; collected and given back now, no collection of it lands in a measured
    // turn.
    if (gc === undefined) {
      throw new Error("The endurance tier runs with --expose-gc, which its project sets.");
    }
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
    searchThread = SearchThread.start({
      databasePath,
      indexFolderPath: join(dataFolder, SEARCH_INDEX_FOLDER_NAME),
      writer: database.writer,
      writeServiceLog: (line) => {
        searchLogLines.push(line);
      },
    });
    teardown.push(() => searchThread.close());
  });

  afterAll(async () => {
    daemonStop.abort();
    const failures: unknown[] = [];
    for (const undo of teardown.toReversed()) {
      try {
        await undo();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "The tier's teardown failed");
    }
  });

  it("builds the index from the database at the start, merged, in budget", async () => {
    const { buildMs, daemonPeakMiB, childCount, childrenPeakMiB, sampledPeakMiB } = daemonBuild;
    // No moment of the build held more than the daemon's peak and its children's together.
    const peakFootprintMiB = daemonPeakMiB + childrenPeakMiB;
    await searchThread.searchSessions({ query: seeded.words[0] ?? "" });
    console.log(
      `Index build from ${String(SEEDED_SET_SIZE.messages)} messages at the daemon's start: first ` +
        `answer after ${(buildMs / 1000).toFixed(1)} s (budget ${String(REBUILD_BUDGET_MS / 1000)} ` +
        `s), peak footprint ${peakFootprintMiB.toFixed(0)} MiB for the daemon and its build ` +
        `process together (budget ${String(REBUILD_FOOTPRINT_BUDGET_MIB)} MiB): the daemon's ` +
        `${daemonPeakMiB.toFixed(0)} MiB and its ${String(childCount)} children's ` +
        `${childrenPeakMiB.toFixed(0)} MiB, ${sampledPeakMiB.toFixed(0)} MiB at the highest ` +
        `sample; ${residentMemory()}`,
    );
    expect(searchLogLines).toEqual([]);
    // The build merged what it built, so the daemon has none of its merging left to do.
    expect(await searchThread.mergeSegments()).toBe(false);
    expect(buildMs).toBeLessThanOrEqual(REBUILD_BUDGET_MS);
    expect(childCount).toBeGreaterThan(0);
    expect(peakFootprintMiB).toBeLessThanOrEqual(REBUILD_FOOTPRINT_BUDGET_MIB);
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
      ...PROBE_QUERIES.map((query) => [`probe ${query}`, query] as const),
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

  it("finds a settled message within a second of its commit", async () => {
    const sessionId = seeded.typicalSessionId;
    const waitsMs: number[] = [];
    for (let index = 0; index < SETTLED_MESSAGES; index += 1) {
      // A word no other row holds, so its first hit is this message.
      const word = `settledprobe${String(index)}`;
      await database.writer.write([
        {
          sql: `INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
                                            category, type, payload)
                SELECT @id, @sessionId, coalesce(max(sequence), -1) + 1, @at, 0,
                       'assistant_output', 'user.message', @payload
                  FROM session_events WHERE session_id = @sessionId`,
          bindings: {
            id: mintUuidV7(),
            sessionId,
            at: new Date().toISOString(),
            payload: JSON.stringify({ sessionId, message: `${word} settled now` }),
          },
        },
      ]);
      waitsMs.push(
        await timeUntil(async () => {
          const page = await searchThread.searchSessions({ query: `${word} ` });
          return page.groups.length > 0;
        }),
      );
    }
    const longestWaitMs = Math.max(...waitsMs);
    console.log(
      `Settled message to its first hit, ${String(SETTLED_MESSAGES)} messages: ` +
        `${formatTiming(timingOf(waitsMs))}, longest ${longestWaitMs.toFixed(1)} ms ` +
        `(budget ${String(SETTLED_TO_HIT_BUDGET_MS)} ms); ${residentMemory()}`,
    );
    expect(longestWaitMs).toBeLessThanOrEqual(SETTLED_TO_HIT_BUDGET_MS);
  });

  it("reads a stored related list and re-scores one without holding the main thread", async () => {
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
        `${formatTurns(turns)}, budget ${String(MAIN_THREAD_TURN_BUDGET_MS)} ms; ` +
        residentMemory(),
    );
    expect(serviceLogLines).toEqual([]);
    expect(read.p95Ms).toBeLessThanOrEqual(RELATED_LIST_P95_BUDGET_MS);
    expect(turns.longestTurnMs).toBeLessThanOrEqual(MAIN_THREAD_TURN_BUDGET_MS);
  });

  it("answers a search right after the largest session's purge, then merges its rows away", async () => {
    const { largeSessionId } = seeded;
    // The daemon's own purge deletes the session's rows. The seeded sessions are projects, with no
    // managed folder to remove and no provider conversation; no list is on screen and no re-score
    // is measured here; and the log gets one try, so a search's open read holds the purge no
    // longer.
    const purge = new SessionPurge({
      writer: database.writer,
      nodeId: NodeIdSchema.parse("node-endurance"),
      eventLog: { append: (envelope) => Promise.resolve({ id: envelope.id, sequence: 0 }) },
      managedWorkspaces: { deleteFolder: () => Promise.resolve() },
      providerConversations: { deleteConversations: () => Promise.resolve() },
      sessionLock: new KeyedLock<SessionId>(),
      sessionList: { refresh: () => undefined },
      relatedRanking: { rescoreAround: () => undefined },
      shellTable: { closeSessionShells: async () => undefined },
      checkpointRetryDelaysMs: [],
      whenFileCheckEnds: Promise.resolve(),
    });
    const { outcomes } = await purge.purge([largeSessionId as SessionId]);
    expect(outcomes.map((outcome) => outcome.refusedReason)).toEqual([undefined]);
    expect(outcomes[0]?.rowsDeleted).toBeGreaterThan(0);
    // Searched at once, while the index applies the purge.
    const query = seeded.words[0] ?? "";
    const firstPage = await measure(() => searchThread.searchSessions({ query }));
    const page = await searchThread.searchSessions({ query });
    console.log(
      `Most common word right after the largest session's purge: ${formatTiming(firstPage)}  ` +
        `${formatTurns(firstPage)}  ${residentMemory()}`,
    );
    expect(page.groups.map((group) => group.sessionId)).not.toContain(largeSessionId);
    expect(firstPage.p95Ms).toBeLessThanOrEqual(SEARCH_P95_BUDGET_MS);
    expect(firstPage.longestTurnMs).toBeLessThanOrEqual(MAIN_THREAD_TURN_BUDGET_MS);
    // Once the index holds the purge, the merges rewrite each segment that held the session's rows,
    // one at a time and none past the merge cap: the largest merges the daemon runs.
    const outboxRows = database.reader
      .prepare<[], number>("SELECT count(*) FROM session_search_outbox")
      .pluck();
    await timeUntil(() => Promise.resolve(outboxRows.get() === 0));
    const mergesMs: number[] = [];
    let isMoreToMerge = true;
    while (isMoreToMerge && mergesMs.length < MERGES_AT_MOST) {
      const start = performance.now();
      isMoreToMerge = await searchThread.mergeSegments();
      mergesMs.push(performance.now() - start);
    }
    const longestMergeMs = Math.max(0, ...mergesMs);
    console.log(
      `Merges after the purge: ${String(mergesMs.length)} calls, longest ` +
        `${longestMergeMs.toFixed(0)} ms (budget ${String(MERGE_BUDGET_MS)} ms); ${residentMemory()}`,
    );
    expect(isMoreToMerge).toBe(false);
    expect(mergesMs.length).toBeGreaterThan(1);
    expect(longestMergeMs).toBeLessThanOrEqual(MERGE_BUDGET_MS);
    expect(searchLogLines).toEqual([]);
  });
});
