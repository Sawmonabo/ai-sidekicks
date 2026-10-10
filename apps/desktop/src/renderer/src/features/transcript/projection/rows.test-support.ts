// Asks the read-row contract whether a row projected from events a read returned is valid. No app
// component holds a contracts schema, and a feature test that imported `TranscriptReadRowSchema`
// would be a second place the shape is read. It is test support because nothing in production
// decodes a transcript row: the app produces them, and a row projected from the stream never
// leaves the renderer.

import { TranscriptReadRowSchema } from "@ai-sidekicks/contracts/transcript/row";

/**
 * Whether one projected row satisfies the registered read-row contract. It uses the real
 * validator so a projection cannot pass a local check the wire's own shape refuses.
 */
export function isContractTranscriptReadRow(row: unknown): boolean {
  return TranscriptReadRowSchema.safeParse(row).success;
}
