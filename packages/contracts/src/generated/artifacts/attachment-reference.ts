// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attachments a message carries: artifact ids in the order they were staged.

import type { ArtifactId } from "./id.js";

/**
 * A message's attachments: artifact ids, kept in the order the sender staged them. How many a
 * message carries is what the daemon and the provider accept, never a count of the app's own.
 */
export type AttachmentReferenceList = ArtifactId[];

export { validateAttachmentReferenceList } from "../checks/artifacts/attachment-reference.js";
