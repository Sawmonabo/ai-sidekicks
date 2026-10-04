// Asks the bridge's contract whether a projected timeline row is valid. No app component holds
// a contracts schema, and a feature test that imported `TimelineRowSchema` would be a second place
// the shape is read. It is test support because nothing in production decodes a timeline row: the
// app produces them.

import { TimelineRowSchema } from "@ai-sidekicks/contracts/timeline/row";

/**
 * Whether one projected row satisfies the registered timeline-row contract. It uses the real
 * validator so a projection cannot pass a local check and fail the daemon's consumers.
 */
export function isContractTimelineRow(row: unknown): boolean {
  return TimelineRowSchema.safeParse(row).success;
}
