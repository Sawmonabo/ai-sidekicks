// The manifest the daemon keeps for every artifact in a session, and the two
// closed vocabularies it carries.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "../provider/driver/intervention.js";
import { RunIdSchema, type RunId } from "../provider/driver/intervention.js";
import { SessionIdSchema, UserIdSchema, type SessionId, type UserId } from "../session/id.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one
 * workflow phase.
 */
export type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflow_output";
/** Parses an {@link ArtifactType}; any other kind is refused. */
export const ArtifactTypeSchema: z.ZodType<ArtifactType, ArtifactType> = z.enum([
  "file",
  "diff",
  "summary",
  "log",
  "design",
  "workflow_output",
]);

/**
 * Where a manifest is in its life: written but not yet published, published, or
 * replaced by a later manifest.
 */
export type ArtifactState = "pending" | "published" | "superseded";
/** Parses an {@link ArtifactState}. */
export const ArtifactStateSchema: z.ZodType<ArtifactState, ArtifactState> = z.enum([
  "pending",
  "published",
  "superseded",
]);

/**
 * One artifact as the daemon records it: `id` names the manifest and `digest` the content, so two
 * manifests can share one payload. `metadata` is the artifact's freeform provenance and holds its
 * file name and media type.
 */
export interface ArtifactManifest {
  id: ArtifactId;
  sessionId: SessionId;
  /** Absent when no run produced the artifact. */
  runId?: RunId | undefined;
  /** The caller that published the artifact; absent when the daemon produced it itself. */
  createdBy?: UserId | undefined;
  artifactType: ArtifactType;
  /** The payload's SHA-256 digest. A content-addressed manifest always has one. */
  digest: string;
  /** The payload's length in bytes, measured by the daemon rather than declared by the caller. */
  size: number;
  state: ArtifactState;
  metadata: Record<string, unknown>;
  createdAt: string;
}
/** Parses an {@link ArtifactManifest}; a member not listed on it is refused. */
export const ArtifactManifestSchema: z.ZodType<ArtifactManifest> = z
  .object({
    id: ArtifactIdSchema,
    sessionId: SessionIdSchema,
    runId: RunIdSchema.optional(),
    createdBy: UserIdSchema.optional(),
    artifactType: ArtifactTypeSchema,
    digest: z.string(),
    size: countSchema,
    state: ArtifactStateSchema,
    metadata: z.record(z.string(), z.unknown()),
    createdAt: isoDateTimeSchema,
  })
  .strict();
