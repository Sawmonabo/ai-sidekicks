// The id of one artifact manifest, the element type of every attachment list.
import { z } from "zod";

import { brandedUuidIdSchema } from "../internal/branded.js";

/**
 * Identifier of an artifact manifest and the element type of every attachment list. It names the
 * manifest, never its content, which carries a separate SHA-256 `digest`.
 */
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
/** Validates a caller-supplied artifact id. */
export const ArtifactIdSchema: z.ZodType<ArtifactId, ArtifactId> =
  brandedUuidIdSchema<ArtifactId>("ArtifactId");
