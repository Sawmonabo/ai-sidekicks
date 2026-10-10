// The database file at a start: after a crash of the system every write waits for the file's
// check to find it sound, while after an end of the process in this boot or a clean stop writes go
// at once, and a check that cannot run never fails the start; a damaged page the recovery pass
// reads stops the daemon, and its next start repairs the file while the socket answers that the
// service is repairing. The check is stood in, so each test decides when it answers.

import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import { DAEMON_REPAIRING_CODE } from "@ai-sidekicks/contracts/daemon/recovery";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";

import { bootstrap } from "../../bootstrap/index.js";
import {
  DatabaseFileCheck,
  type DatabaseFileCheckAnswer,
} from "../../recovery/database-file/check.js";
import { recordCleanStop, recordRunStart } from "../../recovery/database-file/last-run.js";
import { openDatabase } from "../../session/migration-runner.js";
import type { SearchThread } from "../../session/search/thread/handle.js";
import { DATABASE_FILE_NAME } from "../process.js";
import { answerRepairingWhile } from "../repairing-socket.js";
import {
  DRAIN_NOTHING,
  homeDirectory,
  isSocketAnswering,
  openSession,
  PROCESS_IDENTITY,
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
  it("holds every write after a crash of the system until the check answers, and none otherwise", async () => {
    const heldAnswer = Promise.withResolvers<DatabaseFileCheckAnswer>();
    const answers: (() => Promise<DatabaseFileCheckAnswer>)[] = [
      () => heldAnswer.promise,
      () => new Promise(() => {}),
      () => new Promise(() => {}),
      () => Promise.reject(new Error("The shell is missing")),
    ];
    standInChecks(() => (answers.shift() ?? (() => Promise.reject(new Error("A fifth check"))))());
    // A new file has nothing to check, and its first start knows this machine.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(answers).toHaveLength(4);
    // A run in another boot that never stopped cleanly: the system crashed under it.
    await recordRunStart(databasePath(), "another-boot");

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
    expect(countRecoveryPasses()).toBe(1);
    expect(isStarted).toBe(false);

    heldAnswer.resolve({ outcome: "sound" });
    await (await starting).stop();
    expect(countRecoveryPasses()).toBe(2);
    // A run that ended without a clean stop in this boot: the next start writes while its check
    // never answers.
    await recordRunStart(databasePath(), PROCESS_IDENTITY.bootId);
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(countRecoveryPasses()).toBe(3);

    // The clean stop's record lets the next start write while its check never answers.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    expect(countRecoveryPasses()).toBe(4);

    // A check that cannot run after a crash of the system lets the writes go.
    await recordRunStart(databasePath(), "another-boot");
    await startDaemon(DRAIN_NOTHING);
    expect(countRecoveryPasses()).toBe(5);
    expect(answers).toHaveLength(0);
  }, 30_000);
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
    for (let sequence = 0; sequence < 300; sequence += 1) {
      insert.run(`event-${String(sequence)}`, SESSION_ID, sequence, JSON.stringify({ sequence }));
    }
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

    vi.restoreAllMocks();
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

  it("answers a hello with its token as repairing while the file is repaired, and goes after", async () => {
    bootstrap({ localIpcPath: runFolder.socketPath });
    const repair = Promise.withResolvers<string>();
    const repairing = answerRepairingWhile(runFolder, () => repair.promise);
    // The token is written once the socket is bound, so a hello waits for both.
    await vi.waitFor(
      async () => {
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
        expect(existsSync(runFolder.tokenPath)).toBe(true);
      },
      { timeout: SOCKET_WAIT_MS, interval: 20 },
    );

    const { call } = await openSession();
    const hello = (await call("daemon.hello", {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      sessionToken: await readFile(runFolder.tokenPath, "utf8"),
    })) as { error?: { data?: { type?: string } } };
    expect(hello.error?.data?.type).toBe(DAEMON_REPAIRING_CODE);
    const wrongToken = (await call("daemon.hello", {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      sessionToken: "not-this-start's",
    })) as { error?: { data?: { type?: string } } };
    expect(wrongToken.error?.data?.type).toBe("auth.token_invalid");

    repair.resolve("repaired");
    expect(await repairing).toBe("repaired");
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(false);
  });
});
