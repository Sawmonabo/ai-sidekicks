// Writes one published artifact's manifest and then its payload reference, in one transaction
// behind a check that its session still exists, so a purge cannot land between the check and the
// rows. The manifest goes first because the reference names it. Every producer of artifacts writes
// through here, and its write runs inside the store's exclusion for the payload's key.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { ArtifactManifest, ArtifactType } from "@ai-sidekicks/contracts/artifacts/manifest";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { sessionExistsStatement } from "../session/directory/lookups.js";
import { sessionNotFound } from "../session/not-found.js";
import { mintUuidV7 } from "../uuid-v7.js";

const INSERT_MANIFEST_SQL = `INSERT INTO artifact_manifests
  (id, session_id, run_id, created_by, artifact_type, state, content_hash, size_bytes, metadata,
   created_at)
  VALUES (@id, @sessionId, @runId, @createdBy, @artifactType, 'published', @contentHash,
          @sizeBytes, @metadata, @createdAt)`;
const INSERT_PAYLOAD_REF_SQL = `INSERT INTO artifact_payload_refs
  (id, manifest_id, storage_path, media_type, size_bytes, created_at)
  VALUES (@id, @manifestId, @storagePath, @mediaType, @sizeBytes, @createdAt)`;

/** One published artifact as its producer records it, over a payload already in the store. */
export interface PublishedManifest {
  readonly artifactId: ArtifactId;
  readonly sessionId: SessionId;
  readonly runId: RunId | undefined;
  /** The device the request that made it came from; `undefined` for one the daemon produced. */
  readonly createdBy: DeviceId | undefined;
  readonly artifactType: ArtifactType;
  /** `sha256:<hex>`: the manifest's digest and the payload's key in the store. */
  readonly contentHash: string;
  /** The payload's length, measured by the daemon. */
  readonly sizeBytes: number;
  /** The type read from the payload's bytes, or the producing code's for the daemon's own. */
  readonly mediaType: string;
  /** The manifest's freeform provenance; the media type is recorded in it beside the rest. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** RFC 3339 UTC, millisecond precision. */
  readonly createdAt: string;
}

/**
 * Writes `manifest`'s row and its payload reference, and resolves with the manifest as the wire
 * carries it. Rejects with `session.not_found` once the session is gone, writing neither row.
 */
export async function writePublishedManifest(
  writer: Pick<DatabaseWriter, "write">,
  manifest: PublishedManifest,
): Promise<ArtifactManifest> {
  const metadata = { ...manifest.metadata, mediaType: manifest.mediaType };
  try {
    await writer.write([
      sessionExistsStatement(manifest.sessionId),
      {
        sql: INSERT_MANIFEST_SQL,
        bindings: {
          id: manifest.artifactId,
          sessionId: manifest.sessionId,
          runId: manifest.runId ?? null,
          createdBy: manifest.createdBy ?? null,
          artifactType: manifest.artifactType,
          contentHash: manifest.contentHash,
          sizeBytes: manifest.sizeBytes,
          metadata: JSON.stringify(metadata),
          createdAt: manifest.createdAt,
        },
      },
      {
        sql: INSERT_PAYLOAD_REF_SQL,
        bindings: {
          id: mintUuidV7(),
          manifestId: manifest.artifactId,
          storagePath: manifest.contentHash,
          mediaType: manifest.mediaType,
          sizeBytes: manifest.sizeBytes,
          createdAt: manifest.createdAt,
        },
      },
    ]);
  } catch (error) {
    if (error instanceof WriteRefusedError) {
      throw sessionNotFound(manifest.sessionId);
    }
    throw error;
  }
  return {
    id: manifest.artifactId,
    sessionId: manifest.sessionId,
    ...(manifest.runId === undefined ? {} : { runId: manifest.runId }),
    ...(manifest.createdBy === undefined ? {} : { createdBy: manifest.createdBy }),
    artifactType: manifest.artifactType,
    digest: manifest.contentHash,
    size: manifest.sizeBytes,
    state: "published",
    metadata,
    createdAt: manifest.createdAt,
  };
}
