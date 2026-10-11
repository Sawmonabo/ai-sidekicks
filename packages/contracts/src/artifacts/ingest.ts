// The three calls that stream a caller's file into a session's artifacts, request and reply: open
// a stream, send its bytes in numbered chunks, and complete it.
//
// Every request member is a caller's claim. The daemon derives the real media type and size from
// the bytes it spooled, and those derived values are what the completion answers and what reach
// the manifest.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "./id.js";
import { decodedByteLength } from "../internal/base64.js";
import { FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { countSchema } from "../internal/wire-scalars.js";

/**
 * The most raw bytes one artifact chunk may carry, either way: a chunk a caller streams in, and a
 * byte range `artifact.read` answers. Fixed, so its base64 form plus the message envelope always
 * fits within the wire's `MAX_MESSAGE_BYTES`.
 */
export const ARTIFACT_CHUNK_MAX_BYTES: number = 512 * 1024;

/**
 * Opens an ingest stream for one file.
 *
 * `mediaType` is the caller's guess, omitted when the file declared none and never sent empty.
 * It refuses nothing and is recorded nowhere: the daemon reads the type from the bytes.
 * `declaredSizeBytes` also reserves the stream's spool space, so the stream's decoded bytes may
 * not exceed it.
 */
export interface AttachmentIngestInitRequest {
  sessionId: SessionId;
  /** The run the file is for; absent when no run asked for it. */
  runId?: RunId | undefined;
  fileName: string;
  mediaType?: string | undefined;
  declaredSizeBytes: number;
}
/** Parses an {@link AttachmentIngestInitRequest}; an empty `mediaType` is refused. */
export const AttachmentIngestInitRequestSchema: z.ZodType<
  AttachmentIngestInitRequest,
  AttachmentIngestInitRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema.optional(),
    fileName: z.string().min(1).max(FILE_PATH_MAX_LEN),
    mediaType: z.string().min(1).optional(),
    declaredSizeBytes: countSchema,
  })
  .strict();

/**
 * The opened stream. `ingestId` is a single-use handle, bound to the session and to the stream's
 * lifetime, that every chunk and the completion name.
 */
export interface AttachmentIngestInitResponse {
  ingestId: string;
}
/** Parses an {@link AttachmentIngestInitResponse}. */
export const AttachmentIngestInitResponseSchema: z.ZodType<
  AttachmentIngestInitResponse,
  AttachmentIngestInitResponse
> = z.object({ ingestId: z.string().min(1) }).strict();

/**
 * One chunk of an open stream. `sequenceNumber` counts from 0 with no gaps, and a
 * resent chunk carries the number it was first sent with. `chunk` is the RFC 4648
 * base64 of at most {@link ARTIFACT_CHUNK_MAX_BYTES} raw bytes, because the
 * local wire carries JSON and no binary field.
 */
export interface AttachmentIngestChunkRequest {
  ingestId: string;
  sequenceNumber: number;
  chunk: string;
}
/** Parses an {@link AttachmentIngestChunkRequest}; a chunk over the raw cap is refused. */
export const AttachmentIngestChunkRequestSchema: z.ZodType<
  AttachmentIngestChunkRequest,
  AttachmentIngestChunkRequest
> = z
  .object({
    ingestId: z.string().min(1),
    sequenceNumber: countSchema,
    chunk: z.base64().refine((value) => decodedByteLength(value) <= ARTIFACT_CHUNK_MAX_BYTES, {
      message: `chunk must decode to at most ${ARTIFACT_CHUNK_MAX_BYTES} bytes`,
    }),
  })
  .strict();

/**
 * One chunk's acknowledgement. `receivedBytes` is the stream's running total of decoded bytes
 * after the chunk, so progress is the daemon's count and never the sender's.
 */
export interface AttachmentIngestChunkResponse {
  ingestId: string;
  receivedBytes: number;
}
/** Parses an {@link AttachmentIngestChunkResponse}. */
export const AttachmentIngestChunkResponseSchema: z.ZodType<
  AttachmentIngestChunkResponse,
  AttachmentIngestChunkResponse
> = z.object({ ingestId: z.string().min(1), receivedBytes: countSchema }).strict();

/**
 * Completes a stream. The stream id is the only member: the daemon checks the spooled
 * bytes and commits them, and a resent completion answers with the first one's result.
 */
export interface AttachmentIngestCompleteRequest {
  ingestId: string;
}
/** Parses an {@link AttachmentIngestCompleteRequest}. */
export const AttachmentIngestCompleteRequestSchema: z.ZodType<
  AttachmentIngestCompleteRequest,
  AttachmentIngestCompleteRequest
> = z.object({ ingestId: z.string().min(1) }).strict();

/**
 * What the daemon committed. Every member is derived from the spooled bytes, not taken from the
 * opening request, so a caller that declared the wrong type or size learns what was recorded.
 * `contentHash` is the payload's SHA-256, the manifest's `digest`.
 */
export interface AttachmentIngestCompleteResponse {
  artifactId: ArtifactId;
  contentHash: string;
  normalizedName: string;
  derivedMediaType: string;
  derivedSizeBytes: number;
}
/** Parses an {@link AttachmentIngestCompleteResponse}. */
export const AttachmentIngestCompleteResponseSchema: z.ZodType<
  AttachmentIngestCompleteResponse,
  AttachmentIngestCompleteResponse
> = z
  .object({
    artifactId: ArtifactIdSchema,
    contentHash: z.string().min(1),
    normalizedName: z.string().min(1).max(FILE_PATH_MAX_LEN),
    derivedMediaType: z.string().min(1),
    derivedSizeBytes: countSchema,
  })
  .strict();
