// The one instant every frozen-clock suite in this console starts at.
//
// One reader for one stamp. Four homes held this literal — a view family's
// `.test-support.ts` two other families cannot import, a copy inside one suite, and
// two `test/console/` tiers that spelled it `Date.parse("…")` — which the console
// bans outright and for a reason that bites test data as hard as wire data:
// `Date.parse` reads a timezone-less stamp in the HOST's zone, reads a date-only
// string in UTC, and NORMALIZES a day that does not exist into the next one,
// answering a number in every case. A frozen start that silently moved by a day, or
// by the runner's offset, is a case that turns on where it ran.
//
// So the stamp goes through `parseInstant`, which refuses rather than normalizes,
// and the refusal is raised here rather than defaulted: a start instant nobody could
// read is a broken fixture, and standing one up at epoch zero would run every case
// against a clock forty years from the data it drives.
//
// IT LIVES IN `core/` because `core/` is the bottom of the family DAG and every
// family plus every `test/console/` tier may reach it. The previous home was
// `collaboration/`, a view family the sessions family may not import — which is
// exactly why the sessions family wrote the stamp again.

import { parseInstant } from "./instant.js";

/** The wire spelling, so a case that renders it and a case that clocks it agree. */
export const FROZEN_START_ISO = "2026-01-01T10:00:00.000Z";

/**
 * Any wire stamp a case names, as epoch milliseconds, through the console's reader.
 *
 * HERE RATHER THAN IN EACH SUITE THAT WANTS ONE. The stamp above is the frozen START
 * and several suites need a DIFFERENT moment — a read taken two weeks after an
 * observation, a clock read at the top of a stall case — and each of them reached for
 * `Date.parse` to get it, which is the reading this module exists to keep out of test
 * data. The general form is the same three lines as the specific one and belongs in
 * the same file, so a suite naming its own moment has somewhere to go that is not the
 * banned call.
 *
 * It RAISES rather than defaulting, for the reason the frozen start does: a stamp a
 * case wrote and nobody can read is a broken fixture, and standing one up at epoch
 * zero would run the case against a clock decades from its own data.
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
