// The three requests that stream a caller's file into a session's artifacts: open a
// stream, send its bytes in numbered chunks, and complete it.
//
// Every member here is a caller's claim. The daemon derives the real media type and
// size from the bytes it spooled, and those derived values are what reach the
// manifest.
import { z } from "zod";

import { decodedByteLength } from "../internal/base64.js";
import { FILE_PATH_MAX_LEN, SessionIdSchema, type SessionId } from "../session/session.js";
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
 * `mediaType` is a hint that can only narrow which content signature is expected. It
 * is omitted when the file declared none, never sent empty: absence is a state of its
 * own, and a payload whose type its bytes cannot show is refused when no type was
 * declared. `declaredSizeBytes` also reserves the stream's spool space, so the
 * stream's decoded bytes may not exceed it.
 */
export interface AttachmentIngestInitRequest {
  sessionId: SessionId;
  fileName: string;
  mediaType?: string | undefined;
  declaredSizeBytes: number;
}
/**
 * Parses an {@link AttachmentIngestInitRequest}; an empty `mediaType` is refused.
 *
 * @consumedBy the daemon's attachment upload, which opens on this request
 */
export const AttachmentIngestInitRequestSchema: z.ZodType<
  AttachmentIngestInitRequest,
  AttachmentIngestInitRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    fileName: z.string().min(1).max(FILE_PATH_MAX_LEN),
    mediaType: z.string().min(1).optional(),
    declaredSizeBytes: countSchema,
  })
  .strict();

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
/**
 * Parses an {@link AttachmentIngestChunkRequest}; a chunk over the raw cap is refused.
 *
 * @consumedBy the daemon's attachment upload, which takes each chunk on this request
 */
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
 * Completes a stream. The stream id is the only member: the daemon checks the spooled
 * bytes and commits them, and a resent completion answers with the first one's result.
 */
export interface AttachmentIngestCompleteRequest {
  ingestId: string;
}
/**
 * Parses an {@link AttachmentIngestCompleteRequest}.
 *
 * @consumedBy the daemon's attachment upload, which completes on this request
 */
export const AttachmentIngestCompleteRequestSchema: z.ZodType<
  AttachmentIngestCompleteRequest,
  AttachmentIngestCompleteRequest
> = z.object({ ingestId: z.string().min(1) }).strict();
