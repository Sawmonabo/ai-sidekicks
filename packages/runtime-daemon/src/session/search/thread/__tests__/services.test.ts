// The search thread's start: an index restarted after a crash applies every write it missed and
// counts none twice it already held, and an index folder that is missing, unreadable or built from
// another database is built again from the database in a child process; either way the pages equal
// an FTS5 index's over the same rows, and the outbox empties once the index holds its rows. A build
// cut short is started over from an empty folder, and a build that fails fails the start with what
// it threw.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionIdOf } from "../../__fixtures__/index-rows.js";
import { hitsByQuery, referenceHitsByQuery } from "../../__fixtures__/reference-ranking.js";
import { SearchFixture } from "../../__fixtures__/search-services.js";
import { SeededDirectory } from "../../__fixtures__/seeded-directory.js";
import { openSearchServices } from "../services.js";

describe("the search thread's start", () => {
  let fixture: SearchFixture;
  let directory: SeededDirectory;

  beforeEach(async () => {
    fixture = await SearchFixture.open();
    directory = new SeededDirectory(fixture.database);
    directory.seed(24);
  });

  afterEach(async () => {
    await fixture.close();
  });

  const outboxRowCount = (): number =>
    fixture.database
      .prepare<[], number>("SELECT count(*) FROM session_search_outbox")
      .pluck()
      .get() ?? 0;

  const expectPagesMatchReference = (): void => {
    expect(hitsByQuery((request) => fixture.services().sessionSearch.search(request))).toEqual(
      referenceHitsByQuery(directory.rows()),
    );
  };

  it("loses no hit and counts none twice across a crash on either side of the index's commit", async () => {
    // The index commits, and a crash before the daemon deletes the outbox rows it holds keeps
    // them: the next start deletes them and applies none of them again.
    fixture.isDeletingApplied = false;
    await fixture.settle();
    expect(outboxRowCount()).toBeGreaterThan(0);
    fixture.isDeletingApplied = true;
    await fixture.reopen();
    expect(outboxRowCount()).toBe(0);
    expectPagesMatchReference();

    // Writes commit, and a crash keeps the index from applying them: the next start applies them.
    directory.addMessage(sessionIdOf(2), "deploy the retry worker");
    directory.rename(sessionIdOf(1), "cache review");
    directory.purge(sessionIdOf(5));
    await fixture.reopen();
    expect(outboxRowCount()).toBe(0);
    expectPagesMatchReference();
  });

  it("builds a missing, unreadable or foreign index again and answers the same pages", async () => {
    // The log ends in a row the index never holds, so a build reads the titles, groups and tags
    // past the share of the log its last log row reached once the log rows are read.
    directory.addThinkingUpdate(sessionIdOf(24), "weighing the retry worker");
    await fixture.settle();
    expect(fixture.services().rebuildReason).toBe("missing");
    expect((await fixture.reopen()).rebuildReason).toBeUndefined();
    expectPagesMatchReference();

    const unreadable = await fixture.reopen(async () => {
      await writeFile(join(fixture.indexFolderPath, "meta.json"), "not an index");
    });
    expect(unreadable.rebuildReason).toBe("unreadable");
    expectPagesMatchReference();

    const missing = await fixture.reopen(async () => {
      await rm(fixture.indexFolderPath, { recursive: true });
    });
    expect(missing.rebuildReason).toBe("missing");
    expectPagesMatchReference();

    // A database whose outbox never gave the id the index's newest commit records, as a database
    // started again beside an index it did not build.
    const foreign = await fixture.reopen(() => {
      fixture.database.exec(`
        DELETE FROM session_search_outbox;
        UPDATE sqlite_sequence SET seq = 0 WHERE name = 'session_search_outbox'`);
    });
    expect(foreign.rebuildReason).toBe("another-database");
    expectPagesMatchReference();
    expect(outboxRowCount()).toBe(0);
  });

  it("starts a build cut short over from an empty folder", async () => {
    await fixture.settle();
    // What a build cut short left in its folder never reaches the next build.
    const buildFolderPath = `${fixture.indexFolderPath}.building`;
    const restarted = await fixture.reopen(async () => {
      await rm(fixture.indexFolderPath, { recursive: true });
      await mkdir(buildFolderPath);
      await writeFile(join(buildFolderPath, "meta.json"), "cut short");
    });
    expect(restarted.rebuildReason).toBe("missing");
    expectPagesMatchReference();
  });

  it("fails the start with what the build's process threw", async () => {
    const folder = await mkdtemp(join(tmpdir(), "search-build-"));
    try {
      const starting = openSearchServices({
        reader: fixture.database,
        databasePath: join(folder, "absent.db"),
        indexFolderPath: join(folder, "search-index"),
        onApplied: () => {},
      });
      await expect(starting).rejects.toMatchObject({
        code: "SQLITE_CANTOPEN",
        message: "unable to open database file",
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
