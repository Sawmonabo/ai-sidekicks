// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The three calls that stream a caller's file into a session's artifacts: open a stream, send its bytes in numbered chunks, and complete it.

import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { ArtifactId } from "./id.js";

/**
 * The most bytes one artifact chunk carries, either way: a chunk a caller streams in, and a
 * byte range `artifact.read` answers.
 */
export const ARTIFACT_CHUNK_MAX_BYTES = 524288 as const;

/**
 * Opens an ingest stream for one file. `mediaType` is the caller's guess, absent when the file
 * declared none; it refuses nothing and is recorded nowhere, since the daemon reads the type from
 * the bytes. `declaredSizeBytes` also reserves the stream's spool space, so the stream's bytes
 * may not exceed it. A resend under the same `clientIdempotencyKey` answers the first opening's
 * `ingestId`, never a second stream.
 */
export interface ArtifactIngestStartRequest {
  /**
   * The session the file is for.
   */
  sessionId: SessionId;
  /**
   * The run the file is for; absent when no run asked for it.
   */
  runId?: RunId;
  /**
   * The file's name.
   */
  fileName: string;
  /**
   * The caller's guess at the media type; never sent empty.
   */
  mediaType?: string;
  /**
   * The size the caller declares, in bytes.
   */
  declaredSizeBytes: number;
  /**
   * The key that makes a resent opening one stream.
   */
  clientIdempotencyKey: string;
}
/**
 * The opened stream: `ingestId` is a single-use handle, bound to the session and to the stream's
 * lifetime, that every chunk and the completion name.
 */
export interface ArtifactIngestStartResponse {
  /**
   * The stream's handle.
   */
  ingestId: string;
}
/**
 * One chunk of an open stream. `sequenceNumber` counts from 0 with no gaps, and a resent chunk
 * carries the number it was first sent with; `chunk` is at most
 * [`ARTIFACT_CHUNK_MAX_BYTES`] bytes.
 */
export interface ArtifactIngestWriteRequest {
  /**
   * The stream's handle.
   */
  ingestId: string;
  /**
   * The chunk's place in the stream, from 0.
   */
  sequenceNumber: number;
  /**
   * The chunk's bytes.
   */
  chunk: Uint8Array;
}
/**
 * One chunk's acknowledgment. `receivedBytes` is the stream's running total after the chunk, so
 * progress is the daemon's count and never the sender's.
 */
export interface ArtifactIngestWriteResponse {
  /**
   * The stream's handle.
   */
  ingestId: string;
  /**
   * The bytes the stream has received so far.
   */
  receivedBytes: number;
}
/**
 * Completes a stream. The stream's handle is the only member: the daemon checks the spooled bytes
 * and commits them, and a resent completion answers with the first one's result.
 */
export interface ArtifactIngestCompleteRequest {
  /**
   * The stream's handle.
   */
  ingestId: string;
}
/**
 * What the daemon committed. Every member is derived from the spooled bytes, never taken from the
 * opening request, so a caller that declared the wrong type or size learns what was recorded.
 */
export interface ArtifactIngestCompleteResponse {
  /**
   * The artifact the file became.
   */
  artifactId: ArtifactId;
  /**
   * The payload's SHA-256, the manifest's `digest`.
   */
  contentHash: string;
  /**
   * The file's name as stored.
   */
  normalizedName: string;
  /**
   * The media type read from the bytes.
   */
  derivedMediaType: string;
  /**
   * The size measured from the bytes.
   */
  derivedSizeBytes: number;
}

export {
  validateArtifactIngestCompleteRequest,
  validateArtifactIngestCompleteResponse,
  validateArtifactIngestStartRequest,
  validateArtifactIngestStartResponse,
  validateArtifactIngestWriteRequest,
  validateArtifactIngestWriteResponse,
} from "../checks/artifacts/ingest.js";
