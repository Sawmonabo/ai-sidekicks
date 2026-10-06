// Publishing an artifact from a payload the caller holds whole, and the event payload that
// announces an artifact was published or superseded.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "./id.js";
import {
  ArtifactManifestSchema,
  ArtifactStateSchema,
  ArtifactTypeSchema,
  type ArtifactManifest,
  type ArtifactState,
  type ArtifactType,
} from "./manifest.js";
import { ArtifactPayloadEncodingSchema, type ArtifactPayloadEncoding } from "./operations.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";

/**
 * Publishes one artifact in a single call. `payload` is UTF-8 text as it is, or RFC 4648 base64
 * when `payloadEncoding` is `base64`; absent means `utf8`. The daemon decodes before it hashes, so
 * the digest and size bind the decoded bytes and are never the caller's to declare.
 */
export interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId | undefined;
  artifactType: ArtifactType;
  payload: string;
  payloadEncoding?: ArtifactPayloadEncoding | undefined;
  mediaType: string;
  metadata?: Record<string, unknown> | undefined;
}

const base64PayloadSchema = z.base64();

/**
 * Parses an {@link ArtifactPublishRequest}; an empty `mediaType` and a `base64` payload that is
 * not RFC 4648 base64 are refused.
 */
export const ArtifactPublishRequestSchema: z.ZodType<
  ArtifactPublishRequest,
  ArtifactPublishRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema.optional(),
    artifactType: ArtifactTypeSchema,
    payload: z.string(),
    payloadEncoding: ArtifactPayloadEncodingSchema.optional(),
    mediaType: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.payloadEncoding !== "base64" ||
      base64PayloadSchema.safeParse(request.payload).success,
    { message: "A base64 payload must be RFC 4648 base64.", path: ["payload"] },
  );

/** The published artifact's manifest: its id is the artifact id, its digest the content hash. */
export interface ArtifactPublishResponse {
  manifest: ArtifactManifest;
}
/**
 * Parses an {@link ArtifactPublishResponse}.
 *
 * @consumedBy the daemon's publish service, which answers a publish with this reply
 */
export const ArtifactPublishResponseSchema: z.ZodType<ArtifactPublishResponse> = z
  .object({ manifest: ArtifactManifestSchema })
  .strict();

/**
 * The payload of `artifact.published` and `artifact.superseded`. It names the artifact and its new
 * state and carries no content. A member a newer daemon adds rides along under the index signature,
 * so an older reader keeps it rather than refusing a known event.
 */
export interface ArtifactPublicationPayload {
  [member: string]: unknown;
  sessionId: SessionId;
  artifactId?: ArtifactId | undefined;
  runId?: RunId | undefined;
  diffArtifactId?: ArtifactId | undefined;
  state: ArtifactState;
}
/** Parses an {@link ArtifactPublicationPayload}; a member not listed on it is kept, not refused. */
export const ArtifactPublicationPayloadSchema: z.ZodType<
  ArtifactPublicationPayload,
  ArtifactPublicationPayload
> = z.looseObject({
  sessionId: SessionIdSchema,
  artifactId: ArtifactIdSchema.optional(),
  runId: RunIdSchema.optional(),
  diffArtifactId: ArtifactIdSchema.optional(),
  state: ArtifactStateSchema,
});
