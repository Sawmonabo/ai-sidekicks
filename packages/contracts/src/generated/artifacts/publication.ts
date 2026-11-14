// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Publishing an artifact from a payload the caller holds whole, and the event payload that announces an artifact was published.

import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { ArtifactId } from "./id.js";
import type { ArtifactManifest, ArtifactType } from "./manifest.js";

/**
 * Publishes one artifact in a single call. The daemon hashes the payload's bytes, so the digest
 * and size are never the caller's to declare, and it reads the recorded type from the bytes. A
 * client's `file` is refused: a file comes in through ingest. A resend under the same
 * `clientIdempotencyKey` answers the first publish's manifest, never a second artifact.
 */
export interface ArtifactPublishRequest {
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The run that produced it; absent when no run did.
   */
  runId?: RunId;
  /**
   * The artifact's kind.
   */
  artifactType: ArtifactType;
  /**
   * The payload's bytes.
   */
  payload: Uint8Array;
  /**
   * The key that makes a resent publish one artifact.
   */
  clientIdempotencyKey: string;
  /**
   * The caller's media type for the payload.
   */
  mediaType: string;
  /**
   * The artifact's freeform provenance.
   */
  metadata?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * The published artifact's manifest: its id is the artifact id, its digest the content hash.
 */
export interface ArtifactPublishResponse {
  /**
   * The manifest the daemon recorded.
   */
  manifest: ArtifactManifest;
}
/**
 * The payload of `artifact.published`: it names the artifact and carries no content; an artifact
 * is never changed in place, so a new version is a new artifact with its own event. A member a
 * newer daemon adds is kept in `rest`, so an older reader keeps it rather than refusing a known
 * event.
 */
export interface ArtifactPublicationPayload {
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The artifact.
   */
  artifactId?: ArtifactId;
  /**
   * The run that produced it.
   */
  runId?: RunId;
  /**
   * The diff artifact that came with it.
   */
  diffArtifactId?: ArtifactId;
  [k: string]: unknown | undefined;
}

export { validateArtifactPublicationPayload } from "../checks/artifacts/publication.js";
