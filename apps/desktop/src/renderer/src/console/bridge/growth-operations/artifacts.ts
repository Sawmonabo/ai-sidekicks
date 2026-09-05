// The artifact plane's ledger rows: the three-call ingest and its abort, the
// manifest and payload reads, the delete, and the allowlist read.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-entry.js";
import { op } from "./operation-entry.js";

/** The artifact rows, in the order the single table carried them. */
/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type ArtifactOperationId = Extract<GrowthOperationId, `artifact${string}`>;

export const ARTIFACT_GROWTH_OPERATIONS: Readonly<
  Record<ArtifactOperationId, GrowthOperationEntry>
> = {
  artifactIngestBegin: op(
    "artifactIngestBegin",
    "artifact-ingest-and-crud",
    "method",
    "open an attachment ingest",
  ),
  artifactIngestWriteChunk: op(
    "artifactIngestWriteChunk",
    "artifact-ingest-and-crud",
    "method",
    "write one ingest chunk",
  ),
  artifactIngestComplete: op(
    "artifactIngestComplete",
    "artifact-ingest-and-crud",
    "method",
    "close an ingest",
  ),
  artifactList: op(
    "artifactList",
    "artifact-ingest-and-crud",
    "method",
    "list a session's artifacts",
  ),
  artifactRead: op(
    "artifactRead",
    "artifact-ingest-and-crud",
    "method",
    "read one artifact — the pane's manifest read, which takes the envelope alone, and its payload fetch, which asks for the bytes and takes them beside the envelope with the encoding to read them by",
  ),
  artifactDelete: op(
    "artifactDelete",
    "artifact-ingest-and-crud",
    "method",
    "delete an artifact and read back the receipt the call settles — where the payload's bytes went, and whether the destroyed relay key has foreclosed re-publish",
  ),
  artifactAllowlistRead: op(
    "artifactAllowlistRead",
    "artifact-allowlist-and-abort",
    "method",
    "read the effective attachment allow-list so the pane can say what it will accept before a file is chosen",
  ),
  artifactIngestAbort: op(
    "artifactIngestAbort",
    "artifact-allowlist-and-abort",
    "method",
    "abort an in-flight ingest",
  ),
};
