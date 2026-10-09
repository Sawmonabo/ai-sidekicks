// The database file's check at a start and the repair of damage met while the daemon runs: after
// an unclean stop every write waits for the check to find the file sound, while after a clean stop
// writes go at once; a damaged page a read meets stops the daemon, and its next start repairs the
// file. The check is stood in, so each test decides when it answers.

import { existsSync } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";

import { recordCleanStop } from "../../recovery/database-file/clean-stop.js";
import {
  DatabaseFileCheck,
  type DatabaseFileCheckAnswer,
} from "../../recovery/database-file/check.js";
import { openDatabase } from "../../session/migration-runner.js";
import { DATABASE_FILE_NAME } from "../process.js";
import {
  DRAIN_NOTHING,
  homeDirectory,
  isSocketAnswering,
  runFolder,
  startDaemon,
  useDaemonFolders,
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
    const answer = Promise.race([answerFor(), stopped.promise]);
    const check = {
      answer,
      stop: () => {
        stopped.resolve({ outcome: "stopped" });
        return answer;
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
  it("holds every write after an unclean stop until the check answers, and none after a clean stop", async () => {
    const heldAnswer = Promise.withResolvers<DatabaseFileCheckAnswer>();
    const answers: Promise<DatabaseFileCheckAnswer>[] = [
      Promise.resolve({ outcome: "sound" }),
      heldAnswer.promise,
      new Promise(() => {}),
    ];
    standInChecks(() => answers.shift() ?? Promise.reject(new Error("A fourth check started")));
    // A first start knows this machine, and its record of it is a write the check would hold.
    await (await startDaemon(DRAIN_NOTHING)).stop();
    // A stop the daemon never made leaves no clean-stop record.
    await rm(`${databasePath()}.clean-stop`);

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

    // The clean stop's record lets the next start write while its check never answers.
    await startDaemon(DRAIN_NOTHING);
    expect(countRecoveryPasses()).toBe(3);
  });
});

describe("damage met while the daemon runs", () => {
  it("stops the daemon when a read meets a damaged page, and the next start repairs the file", async () => {
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
    // A clean stop's record, so the start writes at once, and a check that never answers, so only
    // the recovery pass's read of the session meets the damage.
    await recordCleanStop(databasePath());
    standInChecks(() => new Promise(() => {}));

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
});
