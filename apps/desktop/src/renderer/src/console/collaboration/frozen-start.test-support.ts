// The instant this family's frozen-clock cases start at.
//
// One reader for one stamp. Three suites here start a `ManualClock` at the same
// moment, and each of them spelled it `Date.parse("…")` — which the console bans
// outright and for a reason that bites test data as hard as wire data: `Date.parse`
// reads a timezone-less stamp in the HOST's zone, reads a date-only string in UTC,
// and NORMALIZES a day that does not exist into the next one, answering a number in
// every case. A frozen start that silently moved by a day, or by the runner's
// offset, is a case that turns on where it ran.
//
// So the stamp goes through `parseInstant`, which refuses rather than normalizes,
// and the refusal is raised here rather than defaulted: a start instant nobody could
// read is a broken fixture, and standing one up at epoch zero would run every case
// against a clock forty years from the data it drives.

import { parseInstant } from "../core/index.js";

/** The wire spelling, so a case that renders it and a case that clocks it agree. */
export const FROZEN_START_ISO = "2026-01-01T10:00:00.000Z";

/** {@link FROZEN_START_ISO} as epoch milliseconds, read through the console's reader. */
export function frozenStartMilliseconds(): number {
  const start = parseInstant(FROZEN_START_ISO);
  if (start.kind !== "instant") {
    throw new Error(`the frozen start instant is unreadable: ${FROZEN_START_ISO}`);
  }
  return start.epochMilliseconds;
}
