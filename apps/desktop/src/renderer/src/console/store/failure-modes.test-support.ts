// The event every apply-chokepoint failure-mode suite hands the store.
//
// One home for the builder the four sibling suites share, and now a thin one: the
// event literal and the sequence-to-timestamp rule both moved to
// `session-event.test-support.ts`, which seven suites were each spelling for
// themselves. What survives here is the part that is about THESE suites — the
// session they all drive, and the overrides shape their cases use to make one member
// wrong at a time.
//
// The timestamp rule is still the load-bearing one and is still stated where it now
// lives: several cases deliver sequences `Date` cannot represent at all — `NaN`, an
// infinity, a value far past the millisecond range — and a builder that threw on them
// would fail the test before the store ever saw the event it is supposed to refuse.

import type { ConsoleSessionEvent } from "./entities.js";
import { eventOfKind } from "./session-event.test-support.js";

/** One event at `sequence`, on the session every suite drives. */
export function eventAt(
  sequence: number,
  overrides: Partial<ConsoleSessionEvent> = {},
): ConsoleSessionEvent {
  return { ...eventOfKind("session-1", "run.starting", sequence), ...overrides };
}
