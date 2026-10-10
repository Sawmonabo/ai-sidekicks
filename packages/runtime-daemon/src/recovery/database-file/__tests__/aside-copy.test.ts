// The store's files copied aside: while the last connection closes, folding the write-ahead log
// into the file and removing it between the listing and its copy, the copy still holds every
// commit, with the log it never found left out of its record; and a stop ends the copy, leaving
// no copy behind.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";

import { copyDatabaseFilesAside } from "../aside-copy.js";
import { chooseDatabaseFileOperatingSystem } from "../operating-system.js";

const operatingSystem = chooseDatabaseFileOperatingSystem(process.platform);

let dataFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(path.join(os.tmpdir(), "aisk-aside-copy-"));
});

afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true });
});

it("keeps every commit when the log goes while the files are copied", async () => {
  const databasePath = path.join(dataFolder, "daemon.db");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec("CREATE TABLE notes (body TEXT)");
  // The row lives in the log alone until the close folds it into the file.
  database.pragma("wal_autocheckpoint = 0");
  database.prepare("INSERT INTO notes (body) VALUES (?)").run("written before the copy");
  let isFirstCopy = true;

  const folder = await copyDatabaseFilesAside(
    {
      databasePath,
      dataFolder,
      // The database closes once the first file is copied, between that copy and the next.
      operatingSystem: {
        copyFile: async (sourcePath, destinationPath, stopSignal) => {
          await operatingSystem.copyFile(sourcePath, destinationPath, stopSignal);
          if (isFirstCopy) {
            isFirstCopy = false;
            database.close();
          }
        },
      },
      now: () => new Date("2026-10-10T12:00:00.000Z"),
      writeServiceLog: () => {},
    },
    new AbortController().signal,
  );

  const copy = new Database(path.join(folder, "daemon.db"), { readonly: true });
  try {
    expect(copy.prepare("SELECT body FROM notes").pluck().all()).toStrictEqual([
      "written before the copy",
    ]);
  } finally {
    copy.close();
  }
  const record = JSON.parse(await readFile(path.join(folder, "copy.json"), "utf8")) as {
    files: { name: string }[];
  };
  // The index was copied before the close; the log the close removed is left out.
  expect(record.files.map((file) => file.name)).toStrictEqual(["daemon.db-shm", "daemon.db"]);
});

it("ends the copy at a stop and leaves no copy behind", async () => {
  const databasePath = path.join(dataFolder, "daemon.db");
  new Database(databasePath).close();
  const stop = new AbortController();
  stop.abort(new Error("The service is stopping"));

  await expect(
    copyDatabaseFilesAside(
      {
        databasePath,
        dataFolder,
        operatingSystem,
        now: () => new Date("2026-10-10T12:00:00.000Z"),
        writeServiceLog: () => {},
      },
      stop.signal,
    ),
  ).rejects.toThrow();
  expect(await readdir(path.join(dataFolder, "damaged"))).toStrictEqual([]);
});
