// The database file's repair at a start, on a real file with a damaged page: the damaged files
// are copied aside byte for byte, the rows are recovered into a fresh file through the SQLite
// shell, a session the newest backup holds more events of takes them from it while a session the
// file holds more of keeps its own, and the fresh file replaces the damaged one with every
// projection cursor cleared. A backup that cannot be read is passed over, a file the recovery
// cannot read stays untouched with one copy aside however often a start meets it, a replacement a
// crash cut short is finished, and a sound file is left as it is.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKUP_MANIFEST_FILE_NAME } from "@ai-sidekicks/contracts/daemon/backup";

import { openDatabase } from "../../../session/migration-runner.js";
import { repairDatabaseFile } from "../repair.js";

const PAGE_SIZE = 4096;
const DAMAGED_LOG = "the damaged file's log";
const KEPT_SESSION = "11111111-2222-4333-8444-555555555551";
const BACKED_UP_SESSION = "11111111-2222-4333-8444-555555555552";

let dataFolder: string;
let databasePath: string;
let backupFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(path.join(os.tmpdir(), "aisk-repair-"));
  databasePath = path.join(dataFolder, "daemon.db");
  backupFolder = path.join(dataFolder, "backups");
});

afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true });
});

// A database at `filePath` holding `counts[session]` events of each session, and a cursor.
function writeDatabase(filePath: string, counts: Record<string, number>): void {
  const database = openDatabase(filePath);
  const insert = database.prepare(
    `INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns, category,
       type, payload)
     VALUES (?, ?, ?, '2026-10-07T12:00:00.000Z', 0, 'session_lifecycle', 'session.renamed', ?)`,
  );
  for (const [sessionId, count] of Object.entries(counts)) {
    for (let sequence = 0; sequence < count; sequence += 1) {
      insert.run(
        `${sessionId}-${String(sequence)}`,
        sessionId,
        sequence,
        JSON.stringify({ sessionId }),
      );
    }
  }
  database
    .prepare(
      `INSERT INTO projection_cursors (id, session_id, last_sequence, state, updated_at)
       VALUES ('cursor', ?, 0, 'current', '2026-10-07T12:00:00.000Z')`,
    )
    .run(KEPT_SESSION);
  database.close();
}

async function writeBackup(name: string, takenAt: string, counts: Record<string, number>) {
  const folder = path.join(backupFolder, name);
  await mkdir(folder, { recursive: true });
  writeDatabase(path.join(folder, "daemon.db"), counts);
  await writeFile(
    path.join(folder, BACKUP_MANIFEST_FILE_NAME),
    JSON.stringify({
      backupId: name,
      takenAt,
      appVersion: "0.1.0",
      serviceVersion: "0.1.0",
      totalBytes: 1,
      computerName: "this computer",
    }),
  );
}

// Overwrites the first page of the session-event type index with bytes no page holds.
async function damageIndexPage(): Promise<void> {
  const database = new Database(databasePath, { readonly: true });
  const rootPage = database
    .prepare<
      [],
      { rootpage: number }
    >("SELECT rootpage FROM sqlite_schema WHERE name = 'idx_session_events_type'")
    .get()?.rootpage;
  database.close();
  if (rootPage === undefined) {
    throw new Error("The index has no root page");
  }
  const file = await readFile(databasePath);
  file.fill(0xa5, (rootPage - 1) * PAGE_SIZE, rootPage * PAGE_SIZE);
  await writeFile(databasePath, file);
}

// Gives each event a snapshot row pointing at it, then overwrites one of the event table's leaf
// pages, so the snapshots of the events on it point at rows the recovery cannot bring back.
async function damageEventPageUnderSnapshots(sessionId: string, count: number): Promise<void> {
  const database = openDatabase(databasePath);
  const insert = database.prepare(
    `INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
     VALUES (?, ?, ?, x'00', '2026-10-07T12:00:00.000Z')`,
  );
  for (let sequence = 0; sequence < count; sequence += 1) {
    insert.run(`snapshot-${String(sequence)}`, sessionId, sequence);
  }
  database.pragma("wal_checkpoint(TRUNCATE)");
  const leafPage = database
    .prepare<
      [],
      { pageno: number }
    >("SELECT pageno FROM dbstat WHERE name = 'session_events' AND pagetype = 'leaf' ORDER BY pageno LIMIT 1 OFFSET 1")
    .get()?.pageno;
  database.close();
  if (leafPage === undefined) {
    throw new Error("The event table has no second leaf page");
  }
  const file = await readFile(databasePath);
  file.fill(0xa5, (leafPage - 1) * PAGE_SIZE, leafPage * PAGE_SIZE);
  await writeFile(databasePath, file);
}

function countRows(table: "session_snapshots"): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (
      database.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()
        ?.count ?? 0
    );
  } finally {
    database.close();
  }
}

function countEvents(sessionId: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (
      database
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?")
        .get(sessionId)?.count ?? 0
    );
  } finally {
    database.close();
  }
}

function repair() {
  return repairDatabaseFile({
    databasePath,
    dataFolder,
    readBackupFolder: () => Promise.resolve(backupFolder),
    now: () => new Date("2026-10-07T13:00:00.000Z"),
    writeServiceLog: () => {},
  });
}

describe("the database file's repair", () => {
  it("recovers a damaged file, taking each session from whichever source holds more of it", async () => {
    writeDatabase(databasePath, { [KEPT_SESSION]: 4, [BACKED_UP_SESSION]: 2 });
    await writeBackup("older", "2026-10-05T03:00:00.000Z", { [BACKED_UP_SESSION]: 9 });
    await writeBackup("newest", "2026-10-06T03:00:00.000Z", {
      [KEPT_SESSION]: 1,
      [BACKED_UP_SESSION]: 5,
    });
    await damageIndexPage();
    const damagedBytes = await readFile(databasePath);

    const result = await repair();

    // An unrepaired outcome carries why, which the failure names.
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "repaired",
      sessionsFromBackup: 1,
    });
    if (result.outcome !== "repaired") {
      throw new Error("The file was not repaired");
    }
    expect(await readFile(path.join(result.asideFolder, "daemon.db"))).toStrictEqual(damagedBytes);
    expect(countEvents(KEPT_SESSION)).toBe(4);
    expect(countEvents(BACKED_UP_SESSION)).toBe(5);
    const repaired = new Database(databasePath, { readonly: true });
    try {
      expect(repaired.pragma("integrity_check")).toStrictEqual([{ integrity_check: "ok" }]);
      expect(
        repaired.prepare("SELECT COUNT(*) AS count FROM projection_cursors").get(),
      ).toStrictEqual({ count: 0 });
    } finally {
      repaired.close();
    }
    expect(existsSync(`${databasePath}.recovered`)).toBe(false);
    expect((await readdir(path.join(backupFolder, "newest"))).sort()).toStrictEqual([
      "daemon.db",
      BACKUP_MANIFEST_FILE_NAME,
    ]);

    // A sound file is checked and left as it is.
    await expect(repair()).resolves.toStrictEqual({ outcome: "intact" });
  });

  it("heals with the recovery alone when the newest backup cannot be read", async () => {
    writeDatabase(databasePath, { [KEPT_SESSION]: 4, [BACKED_UP_SESSION]: 2 });
    await writeBackup("newest", "2026-10-06T03:00:00.000Z", { [BACKED_UP_SESSION]: 5 });
    await writeFile(path.join(backupFolder, "newest", "daemon.db"), Buffer.alloc(PAGE_SIZE, 0xa5));
    await damageIndexPage();

    const result = await repair();
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "repaired",
      sessionsFromBackup: 0,
    });
    expect(countEvents(KEPT_SESSION)).toBe(4);
    expect(countEvents(BACKED_UP_SESSION)).toBe(2);
  });

  it("recovers the rows of a lost table page's neighbors, whose snapshots outlive their events", async () => {
    writeDatabase(databasePath, { [KEPT_SESSION]: 200 });
    await damageEventPageUnderSnapshots(KEPT_SESSION, 200);

    const result = await repair();
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "repaired" });
    const recoveredEvents = countEvents(KEPT_SESSION);
    expect(recoveredEvents).toBeGreaterThan(0);
    expect(recoveredEvents).toBeLessThan(200);
    expect(countRows("session_snapshots")).toBe(200);
  });

  it("leaves a file it cannot recover untouched, copied aside once across starts", async () => {
    writeDatabase(databasePath, { [KEPT_SESSION]: 4 });
    const file = await readFile(databasePath);
    // A header no SQLite reads.
    file.fill(0xa5, 0, 100);
    await writeFile(databasePath, file);

    const first = await repair();
    const second = await repair();

    expect(first).toMatchObject({ outcome: "unrepaired" });
    expect(second).toStrictEqual(first);
    expect(await readFile(databasePath)).toStrictEqual(file);
    expect(await readdir(path.join(dataFolder, "damaged"))).toHaveLength(1);
  });

  it("finishes a replacement a crash cut short instead of recovering again", async () => {
    writeDatabase(databasePath, { [KEPT_SESSION]: 4 });
    await damageIndexPage();
    await writeFile(`${databasePath}-wal`, DAMAGED_LOG);
    writeDatabase(`${databasePath}.recovered`, { [KEPT_SESSION]: 3 });
    await writeFile(`${databasePath}.recovered-ready`, "");

    await expect(repair()).resolves.toStrictEqual({ outcome: "intact" });
    // The damaged file's log is gone; the check of the replaced file may open a log of its own.
    const log = `${databasePath}-wal`;
    expect(existsSync(log) && (await readFile(log, "utf8")) === DAMAGED_LOG).toBe(false);
    expect(existsSync(`${databasePath}.recovered-ready`)).toBe(false);
    expect(existsSync(path.join(dataFolder, "damaged"))).toBe(false);
    expect(countEvents(KEPT_SESSION)).toBe(3);
  });
});
