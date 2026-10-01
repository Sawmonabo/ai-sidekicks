// The request and reply shapes for listing a session's artifacts and reading one
// of them, the one reading of an inline payload's bytes, and the refusal codes
// the artifact calls answer with.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "../provider-driver.js";
import { SessionIdSchema, type SessionId } from "../session.js";

import { ARTIFACT_CHUNK_MAX_BYTES } from "./ingest.js";
import { ArtifactManifestSchema, type ArtifactManifest } from "./manifest.js";

/**
 * How inline payload bytes are written: `utf8` only for bytes that are valid UTF-8
 * exactly, `base64` for everything else. A reader switches on this value and never
 * guesses from the bytes, which is why it travels beside the payload.
 */
export type ArtifactPayloadEncoding = "utf8" | "base64";
/** Parses an {@link ArtifactPayloadEncoding}; any third encoding is refused. */
export const ArtifactPayloadEncodingSchema: z.ZodType<
  ArtifactPayloadEncoding,
  ArtifactPayloadEncoding
> = z.enum(["utf8", "base64"]);

/** Asks for the artifacts of one session. */
export interface ArtifactListRequest {
  sessionId: SessionId;
}
/** Parses an {@link ArtifactListRequest}. */
export const ArtifactListRequestSchema: z.ZodType<ArtifactListRequest, ArtifactListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * A window of a payload's bytes: `length` bytes from `offset`, counted from 0. One
 * window is at most {@link ARTIFACT_CHUNK_MAX_BYTES}, so its encoded bytes fit one
 * message. A window reaching past the payload's end answers the bytes up to the end.
 */
export interface ArtifactByteRange {
  offset: number;
  length: number;
}

/**
 * Asks for one artifact. Without `includePayload` the reply carries the manifest and
 * a handle; with it, the reply carries the bytes when they fit in one message.
 * With `range`, the reply carries that window of the bytes: a payload too large for
 * one message is read whole by asking for its windows in turn, so a text body, a
 * picture or a PDF is never cut short. `version` counts from 1, oldest first;
 * without it the read answers the newest version, which is where a reader opens.
 */
export interface ArtifactReadRequest {
  artifactId: ArtifactId;
  version?: number | undefined;
  includePayload?: boolean | undefined;
  range?: ArtifactByteRange | undefined;
}
/**
 * Parses an {@link ArtifactReadRequest}; a version below 1, a window past the chunk
 * bound, and a window on a read that declines the payload are refused.
 */
export const ArtifactReadRequestSchema: z.ZodType<ArtifactReadRequest, ArtifactReadRequest> = z
  .object({
    artifactId: ArtifactIdSchema,
    version: z.number().int().positive().optional(),
    includePayload: z.boolean().optional(),
    range: z
      .object({
        offset: z.number().int().nonnegative(),
        length: z.number().int().positive().max(ARTIFACT_CHUNK_MAX_BYTES),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((request) => request.range === undefined || request.includePayload !== false, {
    message: "A byte range reads the payload, so it cannot decline it.",
    path: ["range"],
  });

/** A picture's width and height in pixels, as the store measured them at ingest. */
export interface ArtifactPictureSize {
  width: number;
  height: number;
}

/**
 * A PDF's first page, generated at ingest and stored as an artifact of its own, and
 * how many pages the PDF has.
 */
export interface ArtifactPdfPreview {
  firstPageArtifactId: ArtifactId;
  pageCount: number;
}

/**
 * What every read answers beside the payload: which version is in view, how many
 * versions exist and when the one in view was written, and what the store derived
 * at ingest for a picture or a PDF, so a reader can reserve a picture's place and
 * draw a PDF's first page before any payload arrives.
 */
interface ArtifactReadFacts {
  manifest: ArtifactManifest;
  /** Counts from 1, oldest first. Never above `versionCount`, so the count is at least 1. */
  versionNumber: number;
  versionCount: number;
  versionWrittenAt: string;
  /** Present only on a picture. */
  naturalSize?: ArtifactPictureSize | undefined;
  /** Present only on a PDF whose first page could be generated; absent otherwise. */
  pdfPreview?: ArtifactPdfPreview | undefined;
}

/**
 * The reply that hands back a key for the bytes, not the bytes; a reader fetches
 * them with ranged reads. Neither arm is exported: a reader narrows the union by
 * testing `payload`, which is absent here and required on the inline arm.
 */
interface ArtifactReadDeferred extends ArtifactReadFacts {
  /** The content-store key or URL for the payload. Required: it is what this arm is. */
  payloadHandle: string;
  payload?: never;
  payloadEncoding?: never;
}

/**
 * The reply that carries the bytes and the encoding to read them by: the whole
 * payload, or the window a ranged read asked for.
 */
interface ArtifactReadInline extends ArtifactReadFacts {
  /** Allowed beside the bytes; a reply may return both. */
  payloadHandle?: string | undefined;
  payload: string;
  payloadEncoding: ArtifactPayloadEncoding;
}

/**
 * What a read answers: the manifest, plus either a handle to fetch the bytes with or
 * the bytes with their encoding.
 *
 * Two arms, not three independent optional members, because only these two replies
 * can be acted on. With neither a handle nor bytes there is no way to reach the
 * payload; bytes without an encoding cannot be decoded; an encoding without bytes
 * describes nothing. A read that did not ask for the payload lands on the handle arm,
 * and so does one that asked but whose encoded payload would not fit in one message:
 * that is a served answer, not a refusal.
 */
export type ArtifactReadResponse = ArtifactReadDeferred | ArtifactReadInline;

/** The members both arms carry, stated once. */
const artifactReadFactsShape = {
  manifest: ArtifactManifestSchema,
  versionNumber: z.number().int().positive(),
  versionCount: z.number().int(),
  versionWrittenAt: z.iso.datetime({ offset: true }),
  naturalSize: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict()
    .optional(),
  pdfPreview: z
    .object({ firstPageArtifactId: ArtifactIdSchema, pageCount: z.number().int().positive() })
    .strict()
    .optional(),
};

/**
 * Parses an {@link ArtifactReadResponse}. Each arm is strict, which is what refuses a
 * payload or an encoding on the handle arm, and a version past the count is refused.
 */
export const ArtifactReadResponseSchema: z.ZodType<ArtifactReadResponse> = z
  .union([
    z.object({ ...artifactReadFactsShape, payloadHandle: z.string() }).strict(),
    z
      .object({
        ...artifactReadFactsShape,
        payloadHandle: z.string().optional(),
        payload: z.string(),
        payloadEncoding: ArtifactPayloadEncodingSchema,
      })
      .strict(),
  ])
  .refine((reply) => reply.versionNumber <= reply.versionCount, {
    message: "versionNumber must not exceed versionCount",
    path: ["versionNumber"],
  });

/**
 * An inline payload read as text, or why it is not text. A payload that does not
 * decode is an answer, not an error: base64 that will not decode and bytes that
 * are not UTF-8 are each named.
 */
export type ArtifactPayloadText =
  | { status: "text"; text: string }
  | { status: "opaque"; reason: "not-utf8" | "undecodable" };

/**
 * Reads an inline payload by the encoding the reply sent beside it, never by
 * sniffing the bytes. A `utf8` payload is already text; a `base64` payload is
 * decoded and then read as strict UTF-8, because the lenient decoder answers with
 * replacement characters a reader would draw as content.
 */
export function decodeArtifactPayloadText(
  payload: string,
  encoding: ArtifactPayloadEncoding,
): ArtifactPayloadText {
  if (encoding === "utf8") {
    return { status: "text", text: payload };
  }
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return { status: "opaque", reason: "undecodable" };
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  try {
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}

const ARTIFACT_REFUSAL_CODE_VALUES = [
  "artifact.not_found",
  "artifact.too_large",
  "artifact.unsupported_media_type",
  "artifact.scanner_rejected",
  "artifact.ingest_capacity_exhausted",
  "artifact.ingest_stream_invalid",
  "artifact.hash_mismatch",
  "artifact.relay_expired",
  "artifact.fetch_unauthorized",
  "artifact.no_access_key",
] as const;

/** A refusal an artifact call answers with. */
export type ArtifactRefusalCode = (typeof ARTIFACT_REFUSAL_CODE_VALUES)[number];
/** Every {@link ArtifactRefusalCode}. */
export const ARTIFACT_REFUSAL_CODES: readonly ArtifactRefusalCode[] = ARTIFACT_REFUSAL_CODE_VALUES;
