// Asks the bridge's contract whether a projected transcript row is valid. No app component holds
// a contracts schema, and a feature test that imported `TranscriptEventRowSchema` would be a second
// place the shape is read. It is test support because nothing in production decodes a transcript
// row: the app produces them.

import { TranscriptEventRowSchema } from "@ai-sidekicks/contracts/transcript/row";

/**
 * Whether one projected row satisfies the registered transcript-event-row contract. It uses the
 * real validator so a projection cannot pass a local check and fail the daemon's consumers.
 */
export function isContractTranscriptEventRow(row: unknown): boolean {
  return TranscriptEventRowSchema.safeParse(row).success;
}
