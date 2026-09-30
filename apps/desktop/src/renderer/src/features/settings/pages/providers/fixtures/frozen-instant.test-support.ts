// The instant the frozen-clock suites of these fixtures start at.
//
// The stamp goes through `parseInstant`, which refuses rather than normalizes. `Date.parse`
// reads a timezone-less stamp in the host's zone, reads a date-only string in UTC, and
// normalizes a day that does not exist into the next, so a frozen start could silently move by
// a day or the runner's offset. The refusal is raised here rather than defaulted: a start
// instant nobody could read is a broken fixture, and epoch zero would run every case against a
// clock decades from its data.

import { parseInstant } from "@renderer/lib/instant.js";

/** The wire spelling, so a case that renders it and a case that clocks it agree. */
export const FROZEN_START_ISO = "2026-01-01T10:00:00.000Z";

/**
 * Any wire stamp a case names, as epoch milliseconds, through the console's reader.
 *
 * Here so a suite naming its own moment (a read two weeks after an observation, a clock read
 * in a stall case) has somewhere to go other than `Date.parse`. It raises rather than
 * defaulting, like the frozen start.
 */
export function instantMilliseconds(iso: string): number {
  const reading = parseInstant(iso);
  if (reading.kind !== "instant") {
    throw new Error(`a case named an unreadable instant: ${iso}`);
  }
  return reading.epochMilliseconds;
}

/** {@link FROZEN_START_ISO} as epoch milliseconds, read through the console's reader. */
export function frozenStartMilliseconds(): number {
  return instantMilliseconds(FROZEN_START_ISO);
}
