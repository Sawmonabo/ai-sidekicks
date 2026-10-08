// What the search thread serves from: the index, opened or built again, the applier that keeps it
// in step with the outbox, and the two searches over it, all on the thread's read connection. The
// start opens the index, tells the daemon which outbox rows its newest commit already holds,
// applies every row past them, then loads every group's members, so the first search reads an index
// in step with the database.

import type { Database } from "better-sqlite3";

import { SearchIndexApplier } from "../index/applier.js";
import { OutboxReader, type AppliedOutbox } from "../index/outbox.js";
import {
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
  /** The index's folder in the daemon's data folder. */
  readonly indexFolderPath: string;
  /** Hears each durable commit, so the daemon deletes the outbox rows it holds. */
  readonly onApplied: (applied: AppliedOutbox) => void;
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
  mergeWhileIdle(): Promise<boolean>;
  /**
   * Lets go of every held search, waits for the apply under way, then closes the index. Throws what
   * the close threw.
   */
  close(): Promise<void>;
}

/**
 * Opens the index in `options.indexFolderPath`, building it again when it cannot serve, and brings
 * it in step with the database. Throws what the open, the build or the first apply threw, with the
 * index closed.
 */
export async function openSearchServices(options: SearchServicesOptions): Promise<SearchServices> {
  const { reader, onApplied } = options;
  const rows = new IndexRowReader(reader);
  const floorLog = new RowidFloorLog(reader);
  const outbox = new OutboxReader(reader, rows, floorLog);
  const { index, rebuildReason } = await openSearchIndex(options.indexFolderPath, rows, outbox);
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
    index.setGroupMembers(outbox.readEveryGroupsMembers());
    return {
      sessionSearch,
      transcriptSearch: new TranscriptSearchService(reader, index, rows),
      rebuildReason,
      applyWaiting: () => applier.applyWaiting(),
      mergeWhileIdle: () => index.mergeWhileIdle(),
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
