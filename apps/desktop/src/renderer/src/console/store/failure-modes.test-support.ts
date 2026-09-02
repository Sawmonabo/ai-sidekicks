// The event every apply-chokepoint failure-mode suite hands the store.
//
// One home for the two builders the four sibling suites share. They are here and
// not in any one of them because the sequences these suites deliver are the whole
// subject — a second copy would drift, and a drifted `occurredAtFor` would fail a
// suite for a reason that has nothing to do with the chokepoint.

import type { ConsoleSessionEvent } from "./entities.js";

/**
 * A stable wire timestamp per sequence.
 *
 * Separate from `eventAt` because several cases deliver sequences `Date` cannot
 * represent at all — `NaN`, an infinity, a value far past the millisecond range —
 * and a helper that threw on them would fail the test before the store ever saw
 * the event it is supposed to refuse.
 */
export function occurredAtFor(sequence: number): string {
  const startOfDay = Date.UTC(2026, 0, 1);
  const secondsIntoDay = Number.isSafeInteger(sequence) ? Math.min(Math.abs(sequence), 86_399) : 0;
  return new Date(startOfDay + secondsIntoDay * 1000).toISOString();
}

/** One event at `sequence`, on the session every suite drives. */
export function eventAt(
  sequence: number,
  overrides: Partial<ConsoleSessionEvent> = {},
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: occurredAtFor(sequence),
    ...overrides,
  };
}
