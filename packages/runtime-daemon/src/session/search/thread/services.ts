// What the search thread serves from: the index, opened or built again, the applier that keeps it
// in step with the outbox, and the two searches over it, all on the thread's read connection. The
// start opens the index, tells the daemon which outbox rows its newest commit already holds,
// applies every row past them, then loads every group's members, so the first search reads an index
// in step with the database. An index that cannot serve is built again in a child process the start
// waits on, so the build's memory goes with that process, and the start then opens what it built.

import type { Database } from "better-sqlite3";

import type { SearchIndex } from "@ai-sidekicks/search-index";

import { SearchIndexApplier } from "../index/applier.js";
import { OutboxReader, type AppliedOutbox } from "../index/outbox.js";
import {
  buildSearchIndexInChild,
  closeAfterFailure,
  openSearchIndex,
  type SearchIndexRebuildReason,
} from "../index/rebuild.js";
import { IndexRowReader } from "../index/rows.js";
import { RowidFloorLog } from "../rowid-floors.js";
import { SessionSearchService } from "../service.js";
import { TranscriptSearchService } from "../transcript.js";

/** What the search thread's services are opened with. */
export interface SearchServicesOptions {
  /** The thread's read-only connection, which every read runs on. */
  readonly reader: Database;
  /** The database file the reader reads, which a build opens read-only in its own process. */
  readonly databasePath: string;
  /** The index's folder in the daemon's data folder. */
  readonly indexFolderPath: string;
  /** Hears each durable commit, so the daemon deletes the outbox rows it holds. */
  readonly onApplied: (applied: AppliedOutbox) => void;
  /**
   * Aborted when the thread closes while the services open: a build under way ends, and the open
   * rejects with the abort's reason once the build's process has exited.
   */
  readonly signal: AbortSignal;
}

/** The search thread's services, open and in step with the database. */
export interface SearchServices {
  readonly sessionSearch: SessionSearchService;
  readonly transcriptSearch: TranscriptSearchService;
  /** Why the index was built again at this start, if it was. */
  readonly rebuildReason: SearchIndexRebuildReason | undefined;
  /** Applies every outbox row waiting; rejects with what a read or an apply threw. */
  applyWaiting(): Promise<void>;
  /** Runs one merge of the index's segments; resolves whether more merging remains. */
  mergeSegments(): Promise<boolean>;
  /**
   * Lets go of every held search, waits for the apply under way, then closes the index. Throws what
   * the close threw.
   */
  close(): Promise<void>;
}

/**
 * Opens the index in `options.indexFolderPath`, building it again when it cannot serve, and brings
 * it in step with the database. Throws what the open, the build or the first apply threw, with the
 * index closed, or the abort's reason once a build its signal ended has exited.
 */
export async function openSearchServices(options: SearchServicesOptions): Promise<SearchServices> {
  const { reader, onApplied } = options;
  const rows = new IndexRowReader(reader);
  const floorLog = new RowidFloorLog(reader);
  const outbox = new OutboxReader(reader, rows, floorLog);
  const opened = await openSearchIndex(options.indexFolderPath, outbox);
  const rebuildReason = typeof opened === "string" ? opened : undefined;
  const index = typeof opened === "string" ? await openBuiltAgain(options, outbox) : opened;
  try {
    const sessionSearch = new SessionSearchService({
      reader,
      index,
      rows,
      floorLog,
      appliedFloorPosition: () => applier.floorPosition(),
    });
    // A floor log entry goes once neither the applier's caught-up read nor a held search reads it.
    const applier = new SearchIndexApplier(index, outbox, (lastOutboxId) => {
      onApplied({
        lastOutboxId,
        keptFloorPosition: Math.min(
          applier.floorPosition(),
          sessionSearch.oldestHeldFloorPosition() ?? Number.POSITIVE_INFINITY,
        ),
      });
    });
    const lastAppliedOutboxId = index.lastAppliedOutboxId();
    if (lastAppliedOutboxId > 0) {
      onApplied({ lastOutboxId: lastAppliedOutboxId, keptFloorPosition: 0 });
    }
    await applier.applyWaiting();
    index.setGroupMembers(outbox.readEveryGroupMembers());
    return {
      sessionSearch,
      transcriptSearch: new TranscriptSearchService({
        reader,
        index,
        rows,
        floorLog,
        appliedFloorPosition: () => applier.floorPosition(),
      }),
      rebuildReason,
      applyWaiting: () => applier.applyWaiting(),
      mergeSegments: () => index.mergeSegments(),
      close: async () => {
        sessionSearch.letGoOfHeldSearches();
        await applier.stop();
        await index.close();
      },
    };
  } catch (error) {
    throw await closeAfterFailure(index, error, "The search index's open");
  }
}

// Builds the index again in a child process, then opens what it built.
async function openBuiltAgain(
  options: SearchServicesOptions,
  outbox: OutboxReader,
): Promise<SearchIndex> {
  const { databasePath, indexFolderPath, signal } = options;
  await buildSearchIndexInChild(
    { databasePath, indexFolderPath, lastOutboxId: outbox.highestIdGiven() },
    signal,
  );
  const index = await openSearchIndex(indexFolderPath, outbox);
  if (typeof index === "string") {
    throw new Error(`The search index was built again and still could not serve: ${index}`);
  }
  return index;
}
