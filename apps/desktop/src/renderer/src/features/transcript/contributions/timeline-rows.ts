// The transcript's row renderer, claimed on the timeline row seat.

import { registerTimelineRowRenderer } from "@renderer/console/seats/index.js";
import { TranscriptRow } from "../rows/TranscriptRow.js";

/** The owner the transcript's row renderer claims the seat under. */
export const TRANSCRIPT_ROW_OWNER = "ledger fixture shell";

/**
 * Claim the timeline row seat for the transcript's row renderer.
 *
 * A function rather than a module-scope call, so a test can compose it again: the seat's
 * owner scoping replaces a second claim under the same owner.
 */
export function registerFixtureShellRows(): void {
  registerTimelineRowRenderer(TRANSCRIPT_ROW_OWNER, TranscriptRow);
}
