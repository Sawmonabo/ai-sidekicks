// The database file's repair at a start, on a real file with a damaged page: the damaged files
// are copied aside byte for byte, the rows are recovered into a fresh file through the SQLite
// shell, a session the newest backup holds more events of takes them from it while a session the
// file holds more of keeps its own, and the fresh file replaces the damaged one with every
// projection cursor cleared. A backup that cannot be read is passed over, and a sound file is
// left as it is.

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

    expect(result).toMatchObject({ outcome: "repaired", sessionsFromBackup: 1 });
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

    await expect(repair()).resolves.toMatchObject({ outcome: "repaired", sessionsFromBackup: 0 });
    expect(countEvents(KEPT_SESSION)).toBe(4);
    expect(countEvents(BACKED_UP_SESSION)).toBe(2);
  });
});
