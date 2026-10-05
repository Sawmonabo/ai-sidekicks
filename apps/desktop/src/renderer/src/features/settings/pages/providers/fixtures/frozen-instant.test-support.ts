// Wire stamps a case names, read as epoch milliseconds.
//
// The stamp goes through `parseInstant`, which refuses rather than normalizes. `Date.parse`
// reads a timezone-less stamp in the host's zone, reads a date-only string in UTC, and
// normalizes a day that does not exist into the next, so a case's instant could silently move
// by a day or the runner's offset. The refusal is raised rather than defaulted: an instant
// nobody could read is a broken fixture.

import { parseInstant } from "#renderer/lib/instant.js";

/** Any wire stamp a case names, as epoch milliseconds, through the console's reader. */
export function instantMilliseconds(iso: string): number {
  const reading = parseInstant(iso);
  if (reading.kind !== "instant") {
    throw new Error(`a case named an unreadable instant: ${iso}`);
  }
  return reading.epochMilliseconds;
}
