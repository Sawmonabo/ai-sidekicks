// The attachments a message carries: artifact ids in the order they were staged.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "./id.js";

/**
 * Parses a message's attachments: artifact ids, kept in the order the sender staged them. How many
 * a message carries is what the daemon and the provider accept, never a count of the app's own.
 */
export const AttachmentReferenceListSchema: z.ZodType<ArtifactId[], ArtifactId[]> =
  z.array(ArtifactIdSchema);
