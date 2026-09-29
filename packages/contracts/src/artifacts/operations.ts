// The request and reply shapes for listing a session's artifacts and reading one
// of them.
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
