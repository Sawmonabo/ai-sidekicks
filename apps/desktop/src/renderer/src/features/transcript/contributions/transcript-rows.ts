// The transcript's row renderer, registered in the transcript row registry.

import { registerTranscriptRowRenderer } from "../transcript-row-renderer.js";
import { TranscriptRow } from "../rows/TranscriptRow.js";

/** The owner the transcript's row renderer registers under. */
export const TRANSCRIPT_ROW_OWNER = "transcript rows";

/**
 * Register the transcript's row renderer.
 *
 * A function rather than a module-scope call, so a test can compose it again: the
 * registry's owner scoping replaces a second registration under the same owner.
 */
export function registerTranscriptRows(): void {
  registerTranscriptRowRenderer(TRANSCRIPT_ROW_OWNER, TranscriptRow);
}
