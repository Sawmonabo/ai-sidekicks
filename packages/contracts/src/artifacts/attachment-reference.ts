// The attachments a message carries: artifact ids in the order they were staged, and the marker
// that stands in an attachment's own place when it can no longer be delivered.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "./id.js";

/**
 * Parses a message's attachments: artifact ids, kept in the order the sender staged them. How many
 * a message carries is what the daemon and the provider accept, never a count of the app's own.
 */
export const AttachmentReferenceListSchema: z.ZodType<ArtifactId[], ArtifactId[]> =
  z.array(ArtifactIdSchema);

const UNRESOLVED_ATTACHMENT_CAUSE_VALUES = ["deleted"] as const;

/** Why an attachment could not be delivered: `deleted`, its manifest gone with its payload. */
export type UnresolvedAttachmentCause = (typeof UNRESOLVED_ATTACHMENT_CAUSE_VALUES)[number];

/**
 * The marker in the place of an attachment the daemon could not bind to its manifest at delivery,
 * so the list keeps its length and order and the recipient reads why the file is missing.
 */
export interface UnresolvedAttachmentMarker {
  kind: "unresolved";
  artifactId: ArtifactId;
  cause: UnresolvedAttachmentCause;
}
/**
 * Parses an {@link UnresolvedAttachmentMarker}.
 *
 * @consumedBy the daemon's attachment resolver, which delivers a message's files in order
 */
export const UnresolvedAttachmentMarkerSchema: z.ZodType<
  UnresolvedAttachmentMarker,
  UnresolvedAttachmentMarker
> = z
  .object({
    kind: z.literal("unresolved"),
    artifactId: ArtifactIdSchema,
    cause: z.enum(UNRESOLVED_ATTACHMENT_CAUSE_VALUES),
  })
  .strict();
