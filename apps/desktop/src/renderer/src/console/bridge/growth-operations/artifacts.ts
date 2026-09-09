// The artifact plane's ledger rows: the three-call ingest and its abort, the
// manifest and payload reads, the delete, and the allowlist read.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type ArtifactOperationId = Extract<GrowthOperationId, `artifact${string}`>;

/** The artifact rows, in the order the single table carried them. */
export const ARTIFACT_GROWTH_OPERATIONS: Readonly<
  Record<ArtifactOperationId, GrowthOperationEntry>
> = {
  artifactIngestBegin: op("artifactIngestBegin", "artifact-ingest-and-crud", "method"),
  artifactIngestWriteChunk: op("artifactIngestWriteChunk", "artifact-ingest-and-crud", "method"),
  artifactIngestComplete: op("artifactIngestComplete", "artifact-ingest-and-crud", "method"),
  artifactList: op("artifactList", "artifact-ingest-and-crud", "method"),
  artifactRead: op("artifactRead", "artifact-ingest-and-crud", "method"),
  artifactDelete: op("artifactDelete", "artifact-ingest-and-crud", "method"),
  // THE ROW IS UNDER `artifact-ingest-and-crud` AND MINTS NO SLATE ROW OF ITS OWN.
  // That row's own wire text already reads "artifact CRUD method strings", and the
  // visibility update is one of the five interfaces its owning document names beside
  // the publish, the read, the ingest, and the delete. A second row would be a second
  // place for one document's registration to be tracked.
  artifactVisibilityUpdate: op("artifactVisibilityUpdate", "artifact-ingest-and-crud", "method"),
  artifactAllowlistRead: op("artifactAllowlistRead", "artifact-allowlist-and-abort", "method"),
  artifactIngestAbort: op("artifactIngestAbort", "artifact-allowlist-and-abort", "method"),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const ARTIFACT_GROWTH_OPERATION_SUMMARIES: Readonly<Record<ArtifactOperationId, string>> = {
  artifactIngestBegin: "open an attachment ingest",
  artifactIngestWriteChunk: "write one ingest chunk",
  artifactIngestComplete: "close an ingest",
  artifactList: "list a session's artifacts",
  artifactRead:
    "read one artifact — the pane's manifest read, which takes the envelope alone, and its payload fetch, which asks for the bytes and takes them beside the envelope with the encoding to read them by",
  artifactDelete:
    "delete an artifact and read back the receipt the call settles — where the payload's bytes went, and whether the destroyed relay key has foreclosed re-publish",
  artifactVisibilityUpdate:
    "re-classify one artifact as local-only or shared, and read back the class the daemon settled on with the instant it settled",
  artifactAllowlistRead:
    "read the effective attachment allow-list so the pane can say what it will accept before a file is chosen",
  artifactIngestAbort: "abort an in-flight ingest",
};
