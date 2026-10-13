// Asks the read-row contract whether a row projected from events a read returned is valid, its
// packed body read back into the string the wire carried. No app component holds a contracts
// schema, and a feature test that imported `TranscriptReadRowSchema` would be a second place the
// shape is read. It is test support because nothing in production decodes a transcript row: the
// app produces them, and a row projected from the stream never leaves the renderer.

import { TranscriptReadRowSchema } from "@ai-sidekicks/contracts/transcript/row";

import { type ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/**
 * Whether one projected row, its body read back as a string, satisfies the registered read-row
 * contract. It uses the real validator so a projection cannot pass a local check the wire's own
 * shape refuses.
 */
export function isContractTranscriptReadRow(row: ProjectedTranscriptRow): boolean {
  const content = row.content;
  return TranscriptReadRowSchema.safeParse(
    content?.status === "available"
      ? { ...row, content: { ...content, body: content.body.slice(0) } }
      : row,
  ).success;
}
