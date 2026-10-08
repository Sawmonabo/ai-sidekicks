// Opens the search index at the search thread's start, or says why it must be built again from the
// database: its folder is missing, its files cannot be read as an index, or its newest commit
// records an outbox id this database never gave, so it was built from another database. A build
// runs in a child process the search thread starts and waits on, so the build's memory goes with
// that process. It writes into a folder beside the index's, merges it and renames it into place
// once whole, so a build cut short leaves no half-built index; every commit records the outbox's
// highest id at the build's start, and the outbox rows past it are applied after, as at any start.

import { fork } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";

import {
  SearchIndex,
  type IndexRowKind,
  type SearchIndexOptions,
} from "@ai-sidekicks/search-index";

import { withCleanupFailures } from "../../../cleanup-failures.js";
import { rebuildError, type CarriedError } from "../../../worker/carried-error.js";
import { moduleUrlBeside } from "../../../worker/module-url.js";
import { INDEX_ROW_KINDS, sourceRowidOf } from "./columns.js";
import type { OutboxReader } from "./outbox.js";
import { indexRowOf, type IndexRowReader, type SourceRow } from "./rows.js";

// The indexing arena, at its budget's ceiling: the larger the arena, the fewer segments a batch
// flushes and the less merging follows.
const SEARCH_INDEX_OPTIONS: SearchIndexOptions = { writerMemoryBytes: 64 * 1024 * 1024 };

// The error code the index throws for a folder whose files are no index.
const UNREADABLE_INDEX_CODE = "SEARCH_INDEX_UNREADABLE";

const CHILD_URL = moduleUrlBeside(import.meta.url, "child");

// V8 set to favor memory over speed, with a young generation the size of the search thread's, keeps
// the build's heap near what its batches hold, for the lowest peak footprint.
const CHILD_NODE_OPTIONS: readonly string[] = ["--max-semi-space-size=2", "--optimize-for-size"];

/** What the build's child process sends before it exits with a failure: what the build threw. */
export interface SearchIndexBuildFailure {
  readonly type: "failed";
  readonly error: CarriedError;
}

/** What a build in a child process reads and writes. */
export interface SearchIndexBuildRequest {
  readonly databasePath: string;
  readonly indexFolderPath: string;
  /**
   * The outbox's highest id, read before the build reads any row, so every write the build may
   * miss sits in the outbox past it; every commit of the build records it.
   */
  readonly lastOutboxId: number;
}

/** Why the index was built again at a start. */
export type SearchIndexRebuildReason = "missing" | "unreadable" | "another-database";

/**
 * The index in `folderPath`, or, when it cannot serve, why it must be built again, with any folder
 * it left removed. Throws what an open or a read threw.
 */
export async function openSearchIndex(
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

/**
 * Builds the index again from the database in a child process and waits for it to exit; that one
 * extra process exists only while a build runs. Rejects with what the build threw, or with how the
 * process ended when it ended without saying.
 */
export function buildSearchIndexInChild(request: SearchIndexBuildRequest): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const childArguments = [
    request.databasePath,
    request.indexFolderPath,
    String(request.lastOutboxId),
  ];
  const child = fork(CHILD_URL, childArguments, {
    execArgv: [...process.execArgv, ...CHILD_NODE_OPTIONS],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  let failure: CarriedError | undefined;
  child.on("message", (message: SearchIndexBuildFailure) => {
    failure = message.error;
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    const ending = signal === null ? `with code ${String(code)}` : `on ${signal}`;
    reject(
      failure === undefined
        ? new Error(`The search index's build ended ${ending} without saying why`)
        : rebuildError(failure),
    );
  });
  return promise;
}

// Where a build has read one kind's rows to, and its table's highest rowid when the build started:
// a row past it was written after the outbox id the build records, so the outbox carries it.
interface KindReading {
  readonly kind: IndexRowKind;
  readonly lastRowid: number;
  afterRowid: number;
}

/**
 * Indexes every source row into a folder beside `folderPath`, each commit recording
 * `lastOutboxId`, merges its segments, then renames it into place. Throws what a read or the index
 * threw, with the index closed.
 */
export async function buildSearchIndex(
  folderPath: string,
  rows: IndexRowReader,
  lastOutboxId: number,
): Promise<void> {
  const buildPath = `${folderPath}.building`;
  // A build a start cut short left its folder; this build starts from an empty one.
  await rm(buildPath, { recursive: true, force: true });
  await mkdir(buildPath, { recursive: true });
  const index = SearchIndex.open(buildPath, SEARCH_INDEX_OPTIONS);
  try {
    const readingOf = (kind: IndexRowKind): KindReading => ({
      kind,
      lastRowid: rows.lastRowid(kind),
      afterRowid: 0,
    });
    const logReading = readingOf("event");
    const otherReadings = INDEX_ROW_KINDS.filter((kind) => kind !== "event").map(readingOf);
    for (;;) {
      const batchRows = readNextBatch(rows, logReading, otherReadings);
      if (batchRows.length === 0) {
        break;
      }
      await index.apply({
        lastOutboxId,
        rows: batchRows.map(indexRowOf),
        removedKeys: [],
        removedOwners: [],
        groupMembers: [],
      });
    }
    // Merged here, so the daemon opens an index with none of the build's merging left to do.
    let isMoreToMerge = true;
    while (isMoreToMerge) {
      isMoreToMerge = await index.mergeWhileIdle();
    }
  } catch (error) {
    throw await closeAfterFailure(index, error, "The search index's build");
  }
  await index.close();
  await rename(buildPath, folderPath);
}

// A build's next batch: the next log rows, nearly every row the index holds, then each other
// kind's rows through the same share of its table's rowids, or all its rows left once the log rows
// are read. Each segment the build writes then mixes the kinds as the whole index does, so the
// average row length its blocks' score bounds were chosen under is the index's.
function readNextBatch(
  rows: IndexRowReader,
  logReading: KindReading,
  otherReadings: readonly KindReading[],
): SourceRow[] {
  const logRows = readNextRows(rows, logReading, logReading.lastRowid);
  const share = logRows.length === 0 ? 1 : logReading.afterRowid / logReading.lastRowid;
  const otherRows = otherReadings.map((reading) =>
    readNextRows(rows, reading, Math.floor(share * reading.lastRowid)),
  );
  return [logRows, ...otherRows].flat();
}

// The `reading` kind's next rows through `throughRowid`, the reading moved past them.
function readNextRows(
  rows: IndexRowReader,
  reading: KindReading,
  throughRowid: number,
): SourceRow[] {
  const kindRows = rows.readRowsBetween(reading.kind, reading.afterRowid, throughRowid);
  const lastRow = kindRows.at(-1);
  if (lastRow !== undefined) {
    reading.afterRowid = sourceRowidOf(lastRow.key);
  }
  return kindRows;
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
