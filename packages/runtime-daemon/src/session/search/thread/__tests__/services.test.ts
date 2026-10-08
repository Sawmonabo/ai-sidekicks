// The search thread's start: an index restarted after a crash applies every write it missed and
// counts none twice it already held, and an index folder that is missing, unreadable or built from
// another database is built again from the database; either way the pages equal an FTS5 index's
// over the same rows, and the outbox empties once the index holds its rows.

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionIdOf } from "../../__fixtures__/index-rows.js";
import { hitsByQuery, referenceHitsByQuery } from "../../__fixtures__/reference-ranking.js";
import { SearchFixture } from "../../__fixtures__/search-services.js";
import { SeededDirectory } from "../../__fixtures__/seeded-directory.js";

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
    await fixture.settle();
    expect(fixture.rebuildReason).toBe("missing");
    expect(await fixture.reopen()).toBeUndefined();
    expectPagesMatchReference();

    const unreadable = await fixture.reopen(async () => {
      await writeFile(join(fixture.indexFolderPath, "meta.json"), "not an index");
    });
    expect(unreadable).toBe("unreadable");
    expectPagesMatchReference();

    const missing = await fixture.reopen(async () => {
      await rm(fixture.indexFolderPath, { recursive: true });
    });
    expect(missing).toBe("missing");
    expectPagesMatchReference();

    // A database whose outbox never gave the id the index's newest commit records, as a database
    // started again beside an index it did not build.
    const foreign = await fixture.reopen(() => {
      fixture.database.exec(`
        DELETE FROM session_search_outbox;
        UPDATE sqlite_sequence SET seq = 0 WHERE name = 'session_search_outbox'`);
    });
    expect(foreign).toBe("another-database");
    expectPagesMatchReference();
    expect(outboxRowCount()).toBe(0);
  });
});
