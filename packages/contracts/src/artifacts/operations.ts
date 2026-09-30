// The request and reply shapes for listing a session's artifacts and reading one
// of them, the one reading of an inline payload's bytes, and the refusal codes
// the artifact calls answer with.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "../provider-driver.js";
import { SessionIdSchema, type SessionId } from "../session.js";

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
 * Asks for one artifact. Without `includePayload` the reply carries the manifest and
 * a handle; with it, the reply carries the bytes when they fit in one message.
 */
export interface ArtifactReadRequest {
  artifactId: ArtifactId;
  includePayload?: boolean | undefined;
}
/** Parses an {@link ArtifactReadRequest}. */
export const ArtifactReadRequestSchema: z.ZodType<ArtifactReadRequest, ArtifactReadRequest> = z
  .object({ artifactId: ArtifactIdSchema, includePayload: z.boolean().optional() })
  .strict();

/**
 * The reply that hands back a key to fetch the bytes with, not the bytes. Neither
 * arm is exported: a reader narrows the union by testing `payload`, which is absent
 * here and required on the inline arm.
 */
interface ArtifactReadDeferred {
  manifest: ArtifactManifest;
  /** The content-store key or URL to fetch the payload from. Required: it is what this arm is. */
  payloadHandle: string;
  payload?: never;
  payloadEncoding?: never;
}

/** The reply that carries the bytes and the encoding to read them by. */
interface ArtifactReadInline {
  manifest: ArtifactManifest;
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
/**
 * Parses an {@link ArtifactReadResponse}. Each arm is strict, which is what refuses a
 * payload or an encoding on the handle arm.
 */
export const ArtifactReadResponseSchema: z.ZodType<ArtifactReadResponse> = z.union([
  z.object({ manifest: ArtifactManifestSchema, payloadHandle: z.string() }).strict(),
  z
    .object({
      manifest: ArtifactManifestSchema,
      payloadHandle: z.string().optional(),
      payload: z.string(),
      payloadEncoding: ArtifactPayloadEncodingSchema,
    })
    .strict(),
]);

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
  "artifact.too_many_attachments",
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
