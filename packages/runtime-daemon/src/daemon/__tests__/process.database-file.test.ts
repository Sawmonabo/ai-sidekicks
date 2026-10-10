// The database file at a start: when something else changed the file since the last run every
// write waits for the file's check to find it sound, while after any end of the last run, clean or
// not, writes go at once, and a check that cannot run never fails the start but holds the next
// start's writes; a damaged page the recovery pass reads stops the daemon, and its next start
// repairs the file while the socket answers that the service is repairing, with the repair's
// count, takes a stop over a connection whose hello carried the token, and the repaired file takes
// writes at once. A stop during the start, in the repair or while writes wait for the check, ends
// it, and a start a stop came to never says the daemon is ready. The check is stood in, so each
// test decides when it answers.

import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, utimes } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import { DAEMON_READY_LINE } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_REPAIRING_CODE,
  type DaemonRepairProgress,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";

import { bootstrap } from "../../bootstrap/index.js";
import { connect } from "../../ipc/__fixtures__/local-socket-client.js";
import {
  DatabaseFileCheck,
  type DatabaseFileCheckAnswer,
} from "../../recovery/database-file/check.js";
import { recordDatabaseDamage } from "../../recovery/database-file/damage.js";
import { recordCleanStop, recordRunStart } from "../../recovery/database-file/last-run.js";
import { openDatabase } from "../../session/migration-runner.js";
import type { SearchThread } from "../../session/search/thread/handle.js";
import { DATABASE_FILE_NAME, DaemonProcess, type DaemonProcessOptions } from "../process.js";
import { answerRepairingWhile } from "../repairing-socket.js";
import { DaemonStartStoppedError } from "../start-stopped-error.js";
import {
  DRAIN_NOTHING,
  homeDirectory,
  isSocketAnswering,
  openSession,
  runFolder,
  startDaemon,
  useDaemonFolders,
  useSearchThreads,
} from "./process.test-support.js";

const PAGE_SIZE = 4096;
const SESSION_ID = "01a11958-6507-750d-81ea-0411b410a221";
// Long past the pass's first write at a start whose writes are not held: one batch waits 10 ms.
const HELD_WRITE_WAIT_MS = 1_000;
const SOCKET_WAIT_MS = 30_000;

useDaemonFolders();

function databasePath(): string {
  return path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, DATABASE_FILE_NAME);
}

// Stands in for each check a start makes, answering with what `answerFor` returns for it.
function standInChecks(answerFor: () => Promise<DatabaseFileCheckAnswer>): void {
  const spy = vi.spyOn(DatabaseFileCheck, "start").mockImplementation(() => {
    const stopped = Promise.withResolvers<DatabaseFileCheckAnswer>();
    const check = {
      answer: Promise.race([answerFor(), stopped.promise]),
      stop: () => {
        stopped.resolve({ outcome: "stopped" });
      },
    };
    return check as unknown as DatabaseFileCheck;
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
}

// Moves the file's modification time, as a copy or another program writing it would.
async function touchDatabaseFile(): Promise<void> {
  const later = new Date(Date.now() + 60_000);
  await utimes(databasePath(), later, later);
}

function countRecoveryPasses(): number {
  const database = new Database(databasePath(), { readonly: true });
  try {
    return (
      database
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM session_events WHERE type = 'recovery.attempted'")
        .get()?.count ?? 0
    );
  } finally {
    database.close();
  }
}

describe("the database file's check at a start", () => {
  it("holds every write on a file changed or unvouched since the last run until the check answers, and none otherwise", async () => {
    const heldAnswer = Promise.withResolvers<DatabaseFileCheckAnswer>();
    const heldFailure = Promise.withResolvers<DatabaseFileCheckAnswer>();
    const answers: (() => Promise<DatabaseFileCheckAnswer>)[] = [
      () => heldAnswer.promise,
      () => new Promise(() => {}),
      () => new Promise(() => {}),
      () => Promise.reject(new Error("The shell is missing")),
      () => heldFailure.promise,
    ];
    standInChecks(() => (answers.shift() ?? (() => Promise.reject(new Error("A fifth check"))))());
    // A new file has nothing to check, and its first start knows this machine.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(answers).toHaveLength(5);
    // A clean stop's facts the file no longer matches: something else wrote it since.
    await touchDatabaseFile();

    const { starting } = await startHeld(1);
    heldAnswer.resolve({ outcome: "sound" });
    await (await starting).stop();
    expect(countRecoveryPasses()).toBe(2);
    // A run that ended without a clean stop, its process or the machine gone under it: the next
    // start writes while its check never answers.
    await recordRunStart(databasePath());
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(countRecoveryPasses()).toBe(3);

    // The clean stop's record lets the next start write while its check never answers.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(countRecoveryPasses()).toBe(4);

    // A check that cannot run unvouches the file the last run vouched for, so the next start holds
    // its writes; once that start's check fails too, the writes go.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(countRecoveryPasses()).toBe(5);
    const unvouched = await startHeld(5);
    heldFailure.reject(new Error("The shell is missing"));
    await unvouched.starting;
    expect(countRecoveryPasses()).toBe(6);
    expect(answers).toHaveLength(0);
  }, 30_000);

  // Starts a daemon and resolves, with its start, once the start is seen holding its writes: its
  // socket answers and the recovery pass has written nothing past the `passCount` before it.
  async function startHeld(passCount: number): Promise<{ starting: Promise<DaemonProcess> }> {
    let isStarted = false;
    const starting = startDaemon(DRAIN_NOTHING).then((daemon) => {
      isStarted = true;
      return daemon;
    });
    await vi.waitFor(
      async () => {
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );
    await delay(HELD_WRITE_WAIT_MS);
    expect(countRecoveryPasses()).toBe(passCount);
    expect(isStarted).toBe(false);
    return { starting };
  }
});

describe("damage met while the daemon runs", () => {
  it("stops the daemon when the recovery pass reads a damaged page, and repairs the file at the next start", async () => {
    await mkdir(path.dirname(databasePath()), { recursive: true });
    const seeded = openDatabase(databasePath());
    const insert = seeded.prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns, category,
         type, payload)
       VALUES (?, ?, ?, '2026-10-07T12:00:00.000Z', 0, 'session_lifecycle', 'session.renamed', ?)`,
    );
    // One transaction, so the rows take one flush to the drive rather than one each.
    seeded.transaction(() => {
      for (let sequence = 0; sequence < 300; sequence += 1) {
        insert.run(`event-${String(sequence)}`, SESSION_ID, sequence, JSON.stringify({ sequence }));
      }
    })();
    // A rebuild cut short, so the pass rebuilds the session from its first event.
    seeded
      .prepare(
        `INSERT INTO projection_cursors (id, session_id, last_sequence, state, updated_at)
         VALUES ('cursor', ?, -1, 'stale', '2026-10-07T12:00:00.000Z')`,
      )
      .run(SESSION_ID);
    seeded.pragma("wal_checkpoint(TRUNCATE)");
    // The leftmost leaf of the event table, which a read of the session's first events reaches.
    const leafPage = seeded
      .prepare<
        [],
        { pageno: number }
      >("SELECT pageno FROM dbstat WHERE name = 'session_events' AND pagetype = 'leaf' " + "ORDER BY path LIMIT 1")
      .get()?.pageno;
    seeded.close();
    if (leafPage === undefined) {
      throw new Error("The event table has no leaf page");
    }
    const damaged = await open(databasePath(), "r+");
    await damaged.write(Buffer.alloc(PAGE_SIZE, 0xa5), 0, PAGE_SIZE, (leafPage - 1) * PAGE_SIZE);
    await damaged.close();
    // A clean stop's record, so the start writes at once; a check that never answers and a search
    // thread that reads nothing, so only the recovery pass meets the damage.
    await recordCleanStop(databasePath());
    standInChecks(() => new Promise(() => {}));
    useSearchThreads(
      () =>
        ({
          whenWorkerFailed: new Promise(() => {}),
          followIndexCommits: () => () => {},
          mergeSegments: () => Promise.resolve(false),
          close: () => Promise.resolve(),
        }) as unknown as SearchThread,
    );

    const daemon = await startDaemon(DRAIN_NOTHING);
    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true, isFileDamaged: true });
    expect(existsSync(`${databasePath()}.damaged`)).toBe(true);

    // As a file something else changed since a clean stop leaves its record, which would hold the
    // next start's writes; the repaired file was checked whole, so its start writes while its own
    // check never answers.
    await recordCleanStop(databasePath());
    await touchDatabaseFile();
    vi.restoreAllMocks();
    standInChecks(() => new Promise(() => {}));
    await startDaemon(DRAIN_NOTHING);
    expect(existsSync(`${databasePath()}.damaged`)).toBe(false);
    expect(
      await readdir(path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "damaged")),
    ).not.toHaveLength(0);
    const repaired = new Database(databasePath(), { readonly: true });
    try {
      expect(repaired.pragma("quick_check")).toStrictEqual([{ quick_check: "ok" }]);
    } finally {
      repaired.close();
    }
  });

  it("answers a hello with its token as repairing, takes a stop only after one, and goes after", async () => {
    bootstrap({ localIpcPath: runFolder.socketPath });
    const repair = Promise.withResolvers<string>();
    let reportProgress: (progress: DaemonRepairProgress | undefined) => void = () => {};
    const repairing = answerRepairingWhile(
      runFolder,
      (reportRepairProgress, stopAsked) => {
        reportProgress = reportRepairProgress;
        stopAsked.addEventListener("abort", () => {
          repair.reject(stopAsked.reason);
        });
        return repair.promise;
      },
      () => {},
    );
    // The token is written once the socket is bound, so a hello waits for both.
    await vi.waitFor(
      async () => {
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
        expect(existsSync(runFolder.tokenPath)).toBe(true);
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );

    const { call } = await openSession();
    const sessionToken = await readFile(runFolder.tokenPath, "utf8");
    const readRepairing = async () =>
      (
        (await call("daemon.hello", {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken,
        })) as {
          error?: { data?: { type?: string; fields?: unknown } };
        }
      ).error?.data;
    // Each hello carries the count the repair last reported, and none while it gives none.
    expect(await readRepairing()).toStrictEqual({ type: DAEMON_REPAIRING_CODE, fields: {} });
    reportProgress({ done: 120, total: 400 });
    expect(await readRepairing()).toStrictEqual({
      type: DAEMON_REPAIRING_CODE,
      fields: { progress: { done: 120, total: 400 } },
    });
    reportProgress({ done: 400, total: 400 });
    expect((await readRepairing())?.fields).toStrictEqual({ progress: { done: 400, total: 400 } });
    const wrongToken = (await call("daemon.hello", {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      sessionToken: "not-this-start's",
    })) as { error?: { data?: { type?: string } } };
    expect(wrongToken.error?.data?.type).toBe("auth.token_invalid");

    // A connection whose hello lacked the token cannot stop the repair; one whose hello carried it
    // can.
    const stranger = await connect(runFolder.socketPath);
    onTestFinished(() => stranger.close());
    stranger.send({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "daemon.hello",
      params: { protocolVersion: CURRENT_PROTOCOL_VERSION, sessionToken: "not-this-start's" },
    });
    stranger.send({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "daemon.stop",
      params: {},
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
    const strangerStop = (await stranger.replies(2)).find(
      (reply) => (reply as { id: unknown }).id === 2,
    );
    expect(strangerStop).toMatchObject({ error: { data: { type: "auth.token_invalid" } } });
    expect(await call("daemon.stop")).toMatchObject({ result: { accepted: true } });

    await expect(repairing).rejects.toThrow("A stop was asked for over the socket");
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(false);
  });
});

// Starts a daemon whose service log lands in `serviceLog`, stopped by a signal when `stopRequest`
// aborts.
function startDaemonLogging(
  serviceLog: string[],
  stopRequest: AbortController = new AbortController(),
  onLine: (line: string) => void = () => {},
): Promise<DaemonProcess> {
  return startDaemon(DRAIN_NOTHING, {}, (options: DaemonProcessOptions) =>
    DaemonProcess.start({
      ...options,
      stopSignal: stopRequest.signal,
      writeServiceLog: (line) => {
        serviceLog.push(line);
        onLine(line);
      },
    }),
  );
}

describe("a stop during the start", () => {
  it("ends the start while writes wait for the check, and in the repair, leaving the file to the next", async () => {
    standInChecks(() => new Promise(() => {}));
    await (await startDaemonLogging([])).stop();
    // Something else wrote the file since its clean stop, so the next start's writes, the
    // recovery pass's first, wait for a check that never answers.
    await touchDatabaseFile();
    const heldStop = new AbortController();
    const heldLog: string[] = [];
    const held = startDaemonLogging(heldLog, heldStop);
    await vi.waitFor(
      async () => {
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );
    heldStop.abort("a stop came during the start");
    const stopping = await held;
    expect(await stopping.whenStopped()).toStrictEqual({ isClean: true, isFileDamaged: false });
    expect(heldLog).not.toContainEqual(expect.stringContaining(DAEMON_READY_LINE));
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(false);

    // A run found the file damaged; the stop comes once its copy is aside, as the recovery starts.
    await recordDatabaseDamage(databasePath(), "a page the test names damaged");
    const fileBefore = await readFile(databasePath());
    const repairStop = new AbortController();
    const repairLog: string[] = [];
    const failure = await startDaemonLogging(repairLog, repairStop, (line) => {
      if (line.startsWith("The damaged database's files are copied aside")) {
        repairStop.abort("a stop came during the start");
      }
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonStartStoppedError);
    expect(repairLog).toContain(
      "The service's stop ended the repair; the damaged file stays as it was and its next start " +
        "repairs it",
    );
    expect(await readFile(databasePath())).toStrictEqual(fileBefore);
    expect(existsSync(`${databasePath()}.damaged`)).toBe(true);
    expect(existsSync(`${databasePath()}.recovered-ready`)).toBe(false);
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(false);

    // The next start, with no stop, repairs the file and takes it.
    const repairedLog: string[] = [];
    await startDaemonLogging(repairedLog);
    expect(existsSync(`${databasePath()}.damaged`)).toBe(false);
    expect(repairedLog).toContainEqual(expect.stringContaining(DAEMON_READY_LINE));
  }, 30_000);

  it("ends the recovery pass and says nothing is ready when a stop over the socket comes during it", async () => {
    standInChecks(() => new Promise(() => {}));
    const firstLog: string[] = [];
    await (await startDaemonLogging(firstLog)).stop();
    // The negative control: a start nothing stopped says the daemon is ready.
    expect(firstLog).toContainEqual(expect.stringContaining(DAEMON_READY_LINE));
    // The pass's first write waits for a check that never answers, so the pass is under way when
    // the stop comes.
    await touchDatabaseFile();
    const serviceLog: string[] = [];
    const starting = startDaemonLogging(serviceLog);
    await vi.waitFor(
      async () => {
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );
    // The token is written just after the bind, so a stop sent with the last start's is refused.
    await vi.waitFor(
      async () => {
        const { client, call } = await openSession();
        try {
          expect(await call("daemon.stop")).toMatchObject({ result: { accepted: true } });
        } finally {
          await client.close();
        }
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );

    const daemon = await starting;
    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true, isFileDamaged: false });
    expect(serviceLog).not.toContainEqual(expect.stringContaining(DAEMON_READY_LINE));
    // The pass's held write fails as the stop closes the database, which the pass reads as the
    // stop, never as a failed store.
    expect(serviceLog).toContain(
      "The service's stop ended the recovery pass; its next start rebuilds what it had yet to",
    );
  }, 30_000);
});
