// One admitted session event, built once for every suite that needs one.
//
// Seven copies of this four-line literal were in the tree at once — four spelling it
// inline in a `store/` suite, two more inside sibling `.test-support` modules, and,
// on the branches, three under the name `eventOfKind` in three different families.
// They had already drifted in the two places drift is invisible: two spelled
// `occurredAt` as a fixed literal, so every event a suite applied carried the same
// instant and nothing ordered by time could be tested at all, and two derived it from
// the sequence. Neither reports the other.
//
// It lives in `store/` rather than under `test/console/` because the consumers are
// co-located console suites, and `src/renderer/tsconfig.test.json` inherits
// `rootDir: ".."` — `apps/desktop/src` — so a co-located test importing out of the
// package's `test/` tree is TS6059 rather than a style question. `store/` is then the
// lowest family on the DAG that every consumer sits at or above: the event type is
// declared here, and the families that build one (`agents/`, `settings/`, and the
// store's own suites) all import it from here already.
//
// THE PAYLOAD IS OMITTED RATHER THAN EMPTIED when a caller supplies none, because the
// two are different events to a projector that reads `event.payload?.[member]` and
// this helper must not decide for its callers which one they meant.

import type { ConsoleSessionEvent } from "./entities.js";

/**
 * The instant an event at `sequence` occurred, one second apart and clamped to the day.
 *
 * Derived rather than fixed so a suite applying a burst gets events that can be
 * ORDERED — a shared literal makes every comparison a tie, which is the one reading a
 * timestamp exists to give. Clamped because a suite reaching for a large or unsafe
 * sequence wants an event, not an `Invalid Date` that fails somewhere else entirely.
 */
function occurredAtFor(sequence: number): string {
  const startOfDay = Date.UTC(2026, 0, 1);
  const secondsIntoDay = Number.isSafeInteger(sequence) ? Math.min(Math.abs(sequence), 86_399) : 0;
  return new Date(startOfDay + secondsIntoDay * 1000).toISOString();
}

/**
 * One admitted event of the given kind, numbered so a store's cursor moves.
 *
 * `sessionId` first and explicit rather than read off a store, because the suites that
 * need one are split: the store's own suites hold a `SessionStore` and the reconciler,
 * queue, and degradation suites hold no store at all. A caller with a store passes
 * `sessionStore.sessionId`, which is the same reading one argument earlier.
 */
export function eventOfKind(
  sessionId: string,
  kind: ConsoleSessionEvent["kind"],
  sequence: number,
  payload?: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind,
    occurredAt: occurredAtFor(sequence),
    ...(payload === undefined ? {} : { payload }),
  };
}
