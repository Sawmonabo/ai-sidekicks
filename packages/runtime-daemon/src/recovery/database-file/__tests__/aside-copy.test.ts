// The store's files copied aside while the last connection closes: the close folds the
// write-ahead log into the file and removes it between the listing and its copy, and the copy
// still holds every commit, with the log it never found left out of its record.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { copyDatabaseFilesAside } from "../aside-copy.js";

// Runs once, after the first file is copied, so the test can close the database between copies.
let afterFirstCopy: (() => void) | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      const hook = afterFirstCopy;
      afterFirstCopy = undefined;
      hook?.();
    },
  };
});

let dataFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(path.join(os.tmpdir(), "aisk-aside-copy-"));
});

afterEach(async () => {
  afterFirstCopy = undefined;
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
  afterFirstCopy = () => {
    database.close();
  };

  const folder = await copyDatabaseFilesAside({
    databasePath,
    dataFolder,
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    writeServiceLog: () => {},
  });

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
