// Opens the search index at the search thread's start, and builds it again from the database when
// it cannot serve: its folder is missing, its files cannot be read as an index, or its newest
// commit records an outbox id this database never gave, so it was built from another database. A
// build writes into a folder beside the index's and renames it into place once whole, so a start
// cut short leaves no half-built index; every commit records the outbox's highest id at the build's
// start, and the outbox rows past it are applied after, as at any start.

import { mkdir, rename, rm, stat } from "node:fs/promises";

import { SearchIndex, type SearchIndexOptions } from "@ai-sidekicks/search-index";

import { withCleanupFailures } from "../../../cleanup-failures.js";
import { INDEX_ROW_KINDS, sourceRowidOf } from "./columns.js";
import type { OutboxReader } from "./outbox.js";
import { indexRowOf, type IndexRowReader } from "./rows.js";

// The indexing arena, at its budget's ceiling: the larger the arena, the fewer segments a batch
// flushes and the less merging follows.
const SEARCH_INDEX_OPTIONS: SearchIndexOptions = { writerMemoryBytes: 64 * 1024 * 1024 };

// The error code the index throws for a folder whose files are no index.
const UNREADABLE_INDEX_CODE = "SEARCH_INDEX_UNREADABLE";

/** Why the index was built again at a start. */
export type SearchIndexRebuildReason = "missing" | "unreadable" | "another-database";

/** The index opened at a start, and why it was built again if it was. */
export interface OpenedSearchIndex {
  readonly index: SearchIndex;
  readonly rebuildReason: SearchIndexRebuildReason | undefined;
}

/**
 * Opens the index in `folderPath`, building it again from the database first when it cannot serve.
 * Throws what an open, a read or the build threw.
 */
export async function openSearchIndex(
  folderPath: string,
  rows: IndexRowReader,
  outbox: OutboxReader,
): Promise<OpenedSearchIndex> {
  const existing = await openExistingIndex(folderPath, outbox);
  if (typeof existing !== "string") {
    return { index: existing, rebuildReason: undefined };
  }
  await buildSearchIndex(folderPath, rows, outbox);
  return { index: SearchIndex.open(folderPath, SEARCH_INDEX_OPTIONS), rebuildReason: existing };
}

// The index in `folderPath`, or why it must be built again, with any folder it left removed.
async function openExistingIndex(
  folderPath: string,
  outbox: OutboxReader,
): Promise<SearchIndex | SearchIndexRebuildReason> {
  if (!(await isFolderPresent(folderPath))) {
    return "missing";
  }
  let index: SearchIndex;
  try {
    index = SearchIndex.open(folderPath, SEARCH_INDEX_OPTIONS);
  } catch (error) {
    if (isUnreadableIndexError(error)) {
      await rm(folderPath, { recursive: true });
      return "unreadable";
    }
    throw error;
  }
  if (index.lastAppliedOutboxId() <= outbox.highestIdGiven()) {
    return index;
  }
  await index.close();
  await rm(folderPath, { recursive: true });
  return "another-database";
}

// Indexes every source row into a folder beside `folderPath`, then renames it into place.
async function buildSearchIndex(
  folderPath: string,
  rows: IndexRowReader,
  outbox: OutboxReader,
): Promise<void> {
  const buildPath = `${folderPath}.building`;
  // A build a start cut short left its folder; this build starts from an empty one.
  await rm(buildPath, { recursive: true, force: true });
  await mkdir(buildPath, { recursive: true });
  const index = SearchIndex.open(buildPath, SEARCH_INDEX_OPTIONS);
  try {
    // Read before any row, so every write the build may miss sits in the outbox past it.
    const lastOutboxId = outbox.highestIdGiven();
    for (const kind of INDEX_ROW_KINDS) {
      let afterRowid = 0;
      for (;;) {
        const batchRows = rows.readRowsAfter(kind, afterRowid);
        const lastRow = batchRows.at(-1);
        if (lastRow === undefined) {
          break;
        }
        await index.apply({
          lastOutboxId,
          rows: batchRows.map(indexRowOf),
          removedKeys: [],
          removedOwners: [],
          groupMembers: [],
        });
        afterRowid = sourceRowidOf(lastRow.key);
      }
    }
  } catch (error) {
    throw await closeAfterFailure(index, error, "The search index's build");
  }
  await index.close();
  await rename(buildPath, folderPath);
}

/**
 * `error` once `index` is closed after it, carrying what the close threw when the close failed too.
 */
export async function closeAfterFailure(
  index: Pick<SearchIndex, "close">,
  error: unknown,
  operation: string,
): Promise<unknown> {
  const [closed] = await Promise.allSettled([index.close()]);
  const cleanupFailures = closed?.status === "rejected" ? [closed.reason] : [];
  return withCleanupFailures(error, cleanupFailures, operation);
}

async function isFolderPresent(folderPath: string): Promise<boolean> {
  try {
    await stat(folderPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isUnreadableIndexError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === UNREADABLE_INDEX_CODE;
}
