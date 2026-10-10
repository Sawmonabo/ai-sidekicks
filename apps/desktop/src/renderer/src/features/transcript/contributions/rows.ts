// The transcript's row renderer, registered in the transcript row registry.

import { prepareTranscriptRow } from "../rows/preparation.js";
import { registerTranscriptRowRenderer } from "../rows/renderer.js";
import { TranscriptRow, drawsTranscriptRowBody } from "../rows/TranscriptRow.js";

/** The owner the transcript's row renderer registers under. */
export const TRANSCRIPT_ROW_OWNER = "transcript rows";

/**
 * Register the transcript's row renderer. A function so a test can compose it again: owner
 * scoping replaces a second registration under the same owner.
 */
export function registerTranscriptRows(): void {
  registerTranscriptRowRenderer(TRANSCRIPT_ROW_OWNER, {
    render: TranscriptRow,
    drawsBody: drawsTranscriptRowBody,
    prepareRow: prepareTranscriptRow,
  });
}
