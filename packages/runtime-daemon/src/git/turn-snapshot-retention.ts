/**
 * What deleting one run's snapshot refs needs besides the service: the snapshot ref listing parser,
 * the absence probe, and the run context row it reads.
 */

import { stat } from "node:fs/promises";

/**
 * A SHA-1 or SHA-256 id, checked before it enters an argv. With `show-ref --verify` and the
 * runner's exit check it stops a bare `rev-parse` echo from passing as `already-captured`.
 */
export const OBJECT_ID_PATTERN: RegExp = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface SnapshotRefListingEntry {
  readonly objectId: string;
  readonly ref: string;
}

/**
 * Keeps well-formed `<oid> <refname>` lines under `expectedPrefix`. This judges the name git
 * reported; `--no-deref` at deletion governs what it resolves to. A bad line is dropped, not
 * refused, so it cannot strand the refs beside it.
 */
export function parseSnapshotRefListing(
  listing: Buffer,
  expectedPrefix: string,
): readonly SnapshotRefListingEntry[] {
  const entries: SnapshotRefListingEntry[] = [];
  for (const line of listing.toString("utf8").split("\n")) {
    const separatorIndex: number = line.indexOf(" ");
    if (separatorIndex <= 0) {
      continue;
    }
    const objectId: string = line.slice(0, separatorIndex);
    const ref: string = line.slice(separatorIndex + 1);
    if (!OBJECT_ID_PATTERN.test(objectId) || !ref.startsWith(expectedPrefix)) {
      continue;
    }
    entries.push({ objectId, ref });
  }
  return entries;
}

/**
 * Whether `path` is provably absent: only `ENOENT` and `ENOTDIR` count, so any other failure
 * resolves `false` and lands in `git-dir-unusable`. A read, so it bypasses the mutation seam.
 */
export async function isPathProvablyAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (reason: unknown) {
    const code: string | undefined = (reason as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** One run's context row as the prune reads it; field names are the SQL column names. */
export interface RunContextRow {
  readonly run_id: string;
  readonly git_common_dir: string;
}

/** Bound parameters for looking up one run's context row. */
export interface RunContextLookupParams {
  readonly run_id: string;
}

/** The refusal when the prune is called on a service built without a `database`. */
export const RETENTION_WITHOUT_DATABASE_MESSAGE: string =
  "TurnSnapshotService: pruneSnapshotsForRun needs a `database` dependency";
